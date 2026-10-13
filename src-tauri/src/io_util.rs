use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// Write `bytes` to `path` via a temp file in the same directory, then rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "设置文件缺少目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| "设置文件缺少文件名".to_string())?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = parent.join(tmp_name);
    {
        let mut file = File::create(&tmp).map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.write_all(bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.sync_all().map_err(|e| format!("同步临时文件失败：{e}"))?;
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换设置文件失败：{e}"))?;
    Ok(())
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
