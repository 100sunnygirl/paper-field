//! Bounded loopback fixtures for exercising production HTTP clients, never live APIs.
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self { status, headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(&body).unwrap() }
    }
}

pub struct Server {
    pub base: String,
    task: Option<tokio::task::JoinHandle<Vec<Request>>>,
}

impl Server {
    pub async fn start(responses: impl FnOnce(&str) -> Vec<Response>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let responses = responses(&base);
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let request = tokio::time::timeout(Duration::from_secs(5), async {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut raw = Vec::new();
                    let (head, body_start, length) = loop {
                        let mut buf = [0; 4096];
                        let n = stream.read(&mut buf).await.unwrap();
                        assert!(n > 0, "request closed before headers");
                        raw.extend_from_slice(&buf[..n]);
                        assert!(raw.len() <= 1024 * 1024, "fixture request too large");
                        if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8(raw[..end].to_vec()).unwrap();
                            let length = head.lines().filter_map(|s| s.split_once(':'))
                                .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map(|(_, value)| value.trim().parse::<usize>().unwrap()).unwrap_or(0);
                            assert!(length <= 1024 * 1024);
                            break (head, end + 4, length);
                        }
                    };
                    while raw.len() - body_start < length {
                        let mut buf = [0; 4096];
                        let n = stream.read(&mut buf).await.unwrap();
                        assert!(n > 0, "request body truncated");
                        raw.extend_from_slice(&buf[..n]);
                    }
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let request = Request {
                        method: first.next().unwrap().into(),
                        path: first.next().unwrap().into(),
                        headers: lines.map(|line| {
                            let (key, value) = line.split_once(':').unwrap();
                            (key.into(), value.trim().into())
                        }).collect(),
                        body: raw[body_start..body_start + length].to_vec(),
                    };
                    let mut head = format!("HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n", response.status, response.body.len());
                    for (key, value) in response.headers {
                        head.push_str(&format!("{key}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    stream.write_all(head.as_bytes()).await.unwrap();
                    stream.write_all(&response.body).await.unwrap();
                    stream.shutdown().await.unwrap();
                    request
                }).await.expect("fixture request timed out");
                requests.push(request);
            }
            requests
        });
        Self { base, task: Some(task) }
    }

    pub async fn finish(mut self) -> Vec<Request> {
        self.task.as_mut().unwrap().await.expect("fixture server failed")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = &self.task { task.abort(); }
    }
}

/// Bound the whole client flow as well as individual server connections.
pub async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future).await.expect("client contract test timed out")
}
