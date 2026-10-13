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

#[cfg(test)]
mod tests {
    use super::atomic_write;
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
}
