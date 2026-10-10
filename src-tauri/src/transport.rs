//! External-command transport for MinerU doclib.
//!
//! The MinerU provider logic stays independent of the host OS; this module is
//! the only place that knows how requests are carried by curl, ssh, and scp.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub(crate) struct SshResolved {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity: Option<String>,
    pub socket_path: String,
    pub inbox_dir: String,
}

/// Transport target for a doclib-compatible MinerU deployment.
pub(crate) enum DoclibTransport {
    Local(String),
    Ssh(SshResolved),
}

impl DoclibTransport {
    pub(crate) async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        max_time: u64,
        connect_timeout: u64,
    ) -> Result<String, String> {
        match self {
            Self::Local(socket) => local_request(socket, method, path, body, max_time).await,
            Self::Ssh(ssh) => {
                remote_request(ssh, method, path, body, max_time, connect_timeout).await
            }
        }
    }

    pub(crate) async fn get_many(
        &self,
        paths: &[String],
        max_time: u64,
        connect_timeout: u64,
    ) -> Result<Vec<String>, String> {
        match self {
            Self::Local(socket) => {
                let mut bodies = Vec::with_capacity(paths.len());
                for path in paths {
                    bodies.push(local_request(socket, "GET", path, None, max_time).await?);
                }
                Ok(bodies)
            }
            Self::Ssh(ssh) => remote_get_many(ssh, paths, max_time, connect_timeout).await,
        }
    }

    pub(crate) async fn upload_pdf(
        &self,
        pdf: &Path,
        paper_id: &str,
        connect_timeout: u64,
    ) -> Result<String, String> {
        let Self::Ssh(ssh) = self else {
            return Err("本地 MinerU 源不需要上传 PDF".into());
        };
        let home = remote_home(ssh, connect_timeout).await?;
        let inbox = expand_remote_tilde(&ssh.inbox_dir, &home);
        if inbox.contains(['\n', '\r', '\0', ' ', '"', '\'']) {
            return Err("远程暂存目录不能包含空格或引号".into());
        }
        ssh_exec(
            ssh,
            &format!("mkdir -p {}", quote_posix_remote_command(&inbox)),
            None,
            connect_timeout,
        )
        .await?;
        let remote_file = format!("{inbox}/{paper_id}.pdf");
        let mut cmd = Command::new("scp");
        push_ssh_opts(&mut cmd, "-P", ssh, connect_timeout);
        cmd.arg(pdf)
            .arg(format!("{}:{remote_file}", ssh_target(ssh)));
        let output = run_command(cmd, None).await?;
        command_text(&output).map_err(|e| hint_local_read_timeout(&e))?;
        Ok(remote_file)
    }
}

pub(crate) fn expand_remote_tilde(path: &str, home: &str) -> String {
    if path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        path.to_string()
    }
}

pub(crate) fn quote_posix_remote_command(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

async fn run_command(
    mut cmd: Command,
    stdin_data: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let program = cmd.as_std().get_program().to_string_lossy().to_string();
    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("找不到 {program} 命令，请确认它已安装并在 PATH 中")
        } else {
            err.to_string()
        }
    })?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data).await.map_err(|e| e.to_string())?;
            // curl --data-binary @- and ssh both need EOF after the request body.
            drop(stdin);
        }
    }
    child.wait_with_output().await.map_err(|e| e.to_string())
}

/// scp read timeouts are often caused by cloud placeholders rather than SSH.
fn hint_local_read_timeout(message: &str) -> String {
    if message.contains("read local") && message.contains("Operation timed out") {
        format!(
            "{message}（本地文件读取超时：该 PDF 可能在 iCloud/云盘中尚未下载到本机，\
             请先双击打开该文件完成下载，再重新解析）"
        )
    } else {
        message.to_string()
    }
}

fn command_text(output: &std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = if stderr.trim().is_empty() {
        clip(stdout.trim())
    } else {
        clip(stderr.trim())
    };
    if detail.contains("Permission denied") {
        return Err("SSH 登录被拒绝，请检查用户和私钥".into());
    }
    Err(if detail.is_empty() {
        "SSH 命令失败".into()
    } else {
        detail
    })
}

fn clip(value: &str) -> String {
    value.chars().take(280).collect()
}

fn push_ssh_opts(cmd: &mut Command, port_flag: &str, settings: &SshResolved, connect_timeout: u64) {
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o")
        .arg(format!("ConnectTimeout={connect_timeout}"));
    cmd.arg("-o").arg("ServerAliveInterval=5");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg(port_flag).arg(settings.port.to_string());
    if let Some(key) = &settings.identity {
        cmd.arg("-o").arg("IdentitiesOnly=yes");
        cmd.arg("-i").arg(key);
    }
}

fn ssh_target(settings: &SshResolved) -> String {
    format!("{}@{}", settings.user, settings.host)
}

async fn ssh_exec(
    settings: &SshResolved,
    remote: &str,
    stdin_data: Option<&[u8]>,
    connect_timeout: u64,
) -> Result<String, String> {
    let mut cmd = Command::new("ssh");
    push_ssh_opts(&mut cmd, "-p", settings, connect_timeout);
    cmd.arg(ssh_target(settings));
    cmd.arg(remote);
    let output = run_command(cmd, stdin_data).await?;
    command_text(&output)
}

static HOME_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

async fn remote_home(settings: &SshResolved, connect_timeout: u64) -> Result<String, String> {
    let key = format!("{}@{}:{}", settings.user, settings.host, settings.port);
    let cache = HOME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(home) = map.get(&key) {
            return Ok(home.clone());
        }
    }
    let home = ssh_exec(settings, r#"printf %s "$HOME""#, None, connect_timeout).await?;
    let home = home.trim().to_string();
    if home.is_empty() || home.contains(['\n', '\r', ' ']) {
        return Err("无法读取远端主目录".into());
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(key, home.clone());
    }
    Ok(home)
}

fn split_http(raw: &str) -> Result<String, String> {
    const MARK: &str = "\n__PF_HTTP__";
    let Some(idx) = raw.rfind(MARK) else {
        return Err(format!("MinerU 没有返回状态码：{}", clip(raw)));
    };
    let body = raw[..idx].trim().to_string();
    let code: u16 = raw[idx + MARK.len()..].trim().parse().unwrap_or(0);
    if !(200..300).contains(&code) {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| clip(&body));
        return Err(format!("MinerU HTTP {code}：{message}"));
    }
    Ok(body)
}

fn curl_write_flag() -> &'static str {
    "\n__PF_HTTP__%{http_code}"
}

async fn local_request(
    socket: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    max_time: u64,
) -> Result<String, String> {
    let url = format!("http://mineru{path}");
    let mut cmd = Command::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        &max_time.to_string(),
        "--unix-socket",
        socket,
        "-H",
        "Content-Type: application/json",
        "-X",
        method,
        "-w",
        curl_write_flag(),
        &url,
    ]);
    if body.is_some() {
        cmd.arg("--data-binary").arg("@-");
    }
    let output = run_command(cmd, body.map(str::as_bytes)).await?;
    let stdout = command_text(&output)?;
    split_http(&stdout)
}

async fn remote_request(
    settings: &SshResolved,
    method: &str,
    path: &str,
    body: Option<&str>,
    max_time: u64,
    connect_timeout: u64,
) -> Result<String, String> {
    let home = remote_home(settings, connect_timeout).await?;
    let socket = remote_socket(&settings.socket_path, &home)?;
    let data = if body.is_some() {
        " --data-binary @-"
    } else {
        ""
    };
    let url = format!("http://mineru{path}");
    let remote = format!(
        "curl -sS --max-time {max_time} --unix-socket {} -H {} -X {} {} -w {}{data}",
        quote_posix_remote_command(&socket),
        quote_posix_remote_command("Content-Type: application/json"),
        method,
        quote_posix_remote_command(&url),
        quote_posix_remote_command(curl_write_flag()),
    );
    let stdout = ssh_exec(settings, &remote, body.map(str::as_bytes), connect_timeout).await?;
    split_http(&stdout)
}

fn remote_socket(socket_path: &str, home: &str) -> Result<String, String> {
    let socket = expand_remote_tilde(socket_path, home);
    if socket.contains(['\n', '\r', '\0']) {
        return Err("socket 路径无效".into());
    }
    Ok(socket)
}

async fn remote_get_many(
    settings: &SshResolved,
    paths: &[String],
    max_time: u64,
    connect_timeout: u64,
) -> Result<Vec<String>, String> {
    let home = remote_home(settings, connect_timeout).await?;
    let socket = remote_socket(&settings.socket_path, &home)?;
    let mut script = String::new();
    for (index, path) in paths.iter().enumerate() {
        let url = format!("http://mineru{path}");
        script.push_str(&format!("printf '%s\\n' __PF_ITEM_{index}\n"));
        script.push_str(&format!(
            "curl -sS --max-time {max_time} --unix-socket {} {} -w {}\n",
            quote_posix_remote_command(&socket),
            quote_posix_remote_command(&url),
            quote_posix_remote_command(curl_write_flag())
        ));
    }
    let raw = ssh_exec(settings, &script, None, connect_timeout).await?;
    let mut bodies = Vec::with_capacity(paths.len());
    for index in 0..paths.len() {
        let marker = format!("__PF_ITEM_{index}\n");
        let start = raw
            .find(&marker)
            .ok_or_else(|| "MinerU 批量状态返回不完整".to_string())?
            + marker.len();
        let end = if index + 1 < paths.len() {
            raw[start..]
                .find(&format!("__PF_ITEM_{}\n", index + 1))
                .map(|offset| start + offset)
                .unwrap_or(raw.len())
        } else {
            raw.len()
        };
        bodies.push(split_http(&raw[start..end])?);
    }
    Ok(bodies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_tilde_uses_posix_separator() {
        assert_eq!(expand_remote_tilde("~", "/remote/home"), "/remote/home");
        assert_eq!(
            expand_remote_tilde("~/.mineru/doclib.sock", "/remote/home"),
            "/remote/home/.mineru/doclib.sock"
        );
        assert_eq!(
            expand_remote_tilde("/opt/doclib.sock", "/remote/home"),
            "/opt/doclib.sock"
        );
    }

    #[test]
    fn posix_remote_quoting_escapes_single_quotes() {
        assert_eq!(quote_posix_remote_command("plain"), "'plain'");
        assert_eq!(quote_posix_remote_command("a'b"), "'a'\\''b'");
    }

    #[cfg(unix)]
    mod process {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        use super::super::*;

        #[tokio::test]
        async fn command_timeout_kills_child_process() {
            let started = Instant::now();
            let mut cmd = Command::new("sleep");
            cmd.arg("5");
            let err = tokio::time::timeout(Duration::from_secs(1), run_command(cmd, None))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("deadline"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(3));
        }

        #[tokio::test]
        async fn command_input_receives_eof_immediately() {
            let dir = std::env::temp_dir().join(format!("paper-field-eof-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-curl.sh");
            fs::write(&script, "#!/bin/sh\nexec cat\n").unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

            let started = Instant::now();
            let output = tokio::time::timeout(
                Duration::from_secs(3),
                run_command(Command::new(&script), Some(b"hello-body")),
            )
            .await
            .unwrap();
            let output = output.unwrap();
            assert_eq!(command_text(&output).unwrap(), "hello-body");
            assert!(started.elapsed() < Duration::from_secs(2));
            fs::remove_dir_all(&dir).ok();
        }
    }
}
