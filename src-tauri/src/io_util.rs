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
