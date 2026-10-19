use std::fs;
use std::io::Write;
use std::path::Path;

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write `bytes` to `path` via a temp file in the same directory, then rename.
/// The temp name is unique per call (pid + counter, claimed with `create_new`),
/// so two writers of the same file never truncate each other's temp file.
/// `rename` replaces an existing target on every platform (Windows included),
/// so the old file stays in place until the new one is fully written.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "设置文件缺少目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let base = path.file_name().ok_or_else(|| "设置文件缺少文件名".to_string())?;
    let (tmp, mut file) = loop {
        let n = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut name = base.to_os_string();
        name.push(format!(".{}-{n}.tmp", std::process::id()));
        let tmp = parent.join(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => break (tmp, f),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("写入临时文件失败：{e}")),
        }
    };
    let result = (|| {
        file.write_all(bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.sync_all().map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| format!("替换设置文件失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Like `atomic_write`, for secrets: the temp file is created fresh with mode
/// 0600 (never through a planted symlink or an existing inode), the directory
/// is made 0700, and any permission failure is an error.
#[cfg(unix)]
pub fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = path.parent().ok_or_else(|| "密钥文件缺少目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("无法收紧密钥目录权限：{e}"))?;
    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| "密钥文件缺少文件名".to_string())?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = parent.join(tmp_name);
    let open = || {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
    };
    let mut file = match open() {
        Ok(f) => f,
        // Leftover or planted tmp: unlink the name itself (never follows a
        // symlink, detaches any hard link) and create a fresh inode.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::remove_file(&tmp).map_err(|e| format!("无法清理旧的临时密钥文件：{e}"))?;
            open().map_err(|e| format!("写入临时密钥文件失败：{e}"))?
        }
        Err(e) => return Err(format!("写入临时密钥文件失败：{e}")),
    };
    let result = (|| {
        file.write_all(bytes).map_err(|e| format!("写入临时密钥文件失败：{e}"))?;
        file.sync_all().map_err(|e| format!("同步临时密钥文件失败：{e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("替换密钥文件失败：{e}"))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("无法设置密钥文件权限：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 网络响应体上限：防止异常或恶意端点用超大响应耗尽内存。
pub const LLM_BODY_LIMIT: u64 = 8 * 1024 * 1024;
pub const LOOKUP_BODY_LIMIT: u64 = 4 * 1024 * 1024;
pub const MINERU_JSON_LIMIT: u64 = 4 * 1024 * 1024;

/// Read a response body as text, at most `limit` bytes. A declared
/// Content-Length over the limit is refused before reading; otherwise chunks
/// are counted as they arrive and reading stops as soon as the limit is passed.
/// Invalid UTF-8 is replaced, like `Response::text` does for UTF-8 bodies.
pub async fn read_text_capped(mut response: reqwest::Response, limit: u64) -> Result<String, String> {
    let too_big = || format!("响应超过 {}MB，已停止读取", limit.div_ceil(1024 * 1024));
    if response.content_length().is_some_and(|n| n > limit) {
        return Err(too_big());
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取响应失败：{}", reqwest_error_text(e)))? {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(too_big());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// reqwest 错误转成可展示文本：去掉 URL（可能含 userinfo、?api-key= 或预签名参数），
/// 带上 source 链（连接失败、重定向被拒等原因藏在里面），再过一遍 `redact_secrets`。
pub fn reqwest_error_text(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut out = e.to_string();
    let mut cur = std::error::Error::source(&e);
    while let Some(src) = cur {
        let msg = src.to_string();
        if !out.contains(&msg) {
            out.push_str("：");
            out.push_str(&msg);
        }
        cur = src.source();
    }
    crate::secrets::redact_secrets(&out)
}

/// 重定向只许留在同一来源（协议 + 主机 + 端口），另允许同主机 http→https 升级。
/// reqwest 默认策略跨主机时只剥 Authorization/Cookie，自定义头（如 x-api-key）照样
/// 跟到新主机；同主机 https→http 降级时连 Authorization 也不剥。
pub fn redirect_keeps_origin(previous: &reqwest::Url, next: &reqwest::Url) -> bool {
    if next.host_str() != previous.host_str() || next.host_str().is_none() {
        return false;
    }
    match (previous.scheme(), next.scheme()) {
        (a, b) if a == b => previous.port_or_known_default() == next.port_or_known_default(),
        ("http", "https") => true,
        _ => false,
    }
}

const MAX_REDIRECTS: usize = 5;

/// 带凭据请求用的重定向策略：最多 5 跳，离开原来源即报错（不跟随）。
pub fn same_origin_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("重定向次数过多");
        }
        match attempt.previous().last() {
            Some(prev) if redirect_keeps_origin(prev, attempt.url()) => attempt.follow(),
            _ => attempt.error("已拒绝跳转到其他站点的重定向（避免凭据外泄）"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_left(dir: &std::path::Path) -> Vec<String> {
        fs::read_dir(dir).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn replaces_existing_target_and_leaves_no_tmp() {
        let d = crate::test_util::unique_temp_dir("pf-atomic-replace");
        let p = d.join("settings.json");
        fs::write(&p, b"old old old").unwrap();
        atomic_write(&p, b"new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        atomic_write(&p, b"newer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"newer");
        assert!(tmp_left(&d).is_empty(), "{:?}", tmp_left(&d));
    }

    #[test]
    fn concurrent_writers_never_mix_content() {
        let d = crate::test_util::unique_temp_dir("pf-atomic-race");
        let p = d.join("settings.json");
        // Distinct, long payloads: a truncated or interleaved temp file can't match any.
        let payloads: Vec<Vec<u8>> = (0..8u8).map(|i| vec![b'a' + i; 256 * 1024]).collect();
        for _ in 0..20 {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let hs: Vec<_> = payloads.iter().cloned().map(|body| {
                let (p, b) = (p.clone(), barrier.clone());
                std::thread::spawn(move || { b.wait(); atomic_write(&p, &body) })
            }).collect();
            let results: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
            // Linux/macOS: concurrent renames onto one target are atomic, all succeed.
            // Windows: MoveFileEx may refuse while another rename is in flight; the
            // old file stays intact, so only require one success there.
            #[cfg(not(windows))]
            for r in &results { r.as_ref().unwrap(); }
            #[cfg(windows)]
            assert!(results.iter().any(|r| r.is_ok()), "{results:?}");
            let got = fs::read(&p).unwrap();
            assert!(payloads.contains(&got), "final file is not one complete write (len {})", got.len());
            assert!(tmp_left(&d).is_empty(), "{:?}", tmp_left(&d));
        }
    }

    #[test]
    fn failed_rename_leaves_no_tmp() {
        let d = crate::test_util::unique_temp_dir("pf-atomic-fail");
        let p = d.join("settings.json");
        fs::create_dir(&p).unwrap();
        fs::write(p.join("keep"), b"x").unwrap();
        assert!(atomic_write(&p, b"new").is_err());
        assert!(p.is_dir());
        assert!(tmp_left(&d).is_empty(), "{:?}", tmp_left(&d));
    }

    fn serve_raw(raw: Vec<u8>) -> String {
        use std::io::{Read as _, Write as _};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let _ = c.write_all(&raw);
            }
        });
        format!("http://{addr}/x")
    }

    fn read_from(raw: Vec<u8>, limit: u64) -> Result<String, String> {
        let url = serve_raw(raw);
        tauri::async_runtime::block_on(async move {
            let response = reqwest::Client::builder().no_proxy().build().unwrap().get(url).send().await.unwrap();
            read_text_capped(response, limit).await
        })
    }

    fn chunked(parts: &[&[u8]]) -> Vec<u8> {
        let mut raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        for part in parts {
            raw.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
            raw.extend_from_slice(part);
            raw.extend_from_slice(b"\r\n");
        }
        raw.extend_from_slice(b"0\r\n\r\n");
        raw
    }

    #[test]
    fn capped_read_accepts_body_up_to_limit() {
        let body = "响应".repeat(100); // 600 bytes
        let raw = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        assert_eq!(read_from(raw.into_bytes(), 600).unwrap(), body);
        let a = [b'a'; 300];
        assert_eq!(read_from(chunked(&[&a, &a]), 600).unwrap(), "a".repeat(600), "恰好等于上限照收");
    }

    #[test]
    fn capped_read_refuses_declared_oversize_before_body() {
        // 头部声称 5 MB 却没有正文：只有 Content-Length 检查能给出超限错误。
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 5242880\r\nConnection: close\r\n\r\n".to_vec();
        assert_eq!(read_from(raw, 4 * 1024 * 1024).unwrap_err(), "响应超过 4MB，已停止读取");
    }

    #[test]
    fn capped_read_stops_streamed_body_past_limit() {
        let a = [b'a'; 400];
        assert_eq!(read_from(chunked(&[&a, &a]), 600).unwrap_err(), "响应超过 1MB，已停止读取");
    }

    #[test]
    fn redirect_policy_keeps_origin_only() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        let base = u("https://api.semanticscholar.org/graph/v1/paper?x=1");
        for ok in ["https://api.semanticscholar.org/other", "https://API.semanticscholar.org:443/x"] {
            assert!(redirect_keeps_origin(&base, &u(ok)), "{ok}");
        }
        for bad in [
            "https://evil.example/graph",
            "https://semanticscholar.org/graph",
            "https://api.semanticscholar.org.evil.example/",
            "http://api.semanticscholar.org/graph",
            "https://api.semanticscholar.org:8443/graph",
            "https://user:pw@evil.example/",
        ] {
            assert!(!redirect_keeps_origin(&base, &u(bad)), "{bad}");
        }
        // 同主机 http→https 升级允许；反过来降级不行
        assert!(redirect_keeps_origin(&u("http://localhost:11434/v1"), &u("https://localhost/v1")));
        assert!(!redirect_keeps_origin(&u("http://localhost:11434/v1"), &u("http://localhost:8080/v1")));
    }

    #[test]
    fn redirect_policy_refuses_cross_host_and_hides_url() {
        // 跳去别的主机（这里是另一个端口）：报错不跟随，错误里不带原 URL 的密钥参数。
        let url = serve_raw(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let err = tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::builder().no_proxy().redirect(same_origin_redirect_policy()).build().unwrap();
            client.get(format!("{url}?api-key=sk-leak-123456")).header("x-api-key", "k").send().await.unwrap_err()
        });
        assert!(err.is_redirect(), "{err:?}");
        let text = reqwest_error_text(err);
        assert!(text.contains("已拒绝跳转到其他站点"), "{text}");
        assert!(!text.contains("sk-leak") && !text.contains("127.0.0.1"), "{text}");
    }
}
