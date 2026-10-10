use std::path::Path;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub(crate) fn home_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("", BaseDirectory::Home)
        .map_err(|e| format!("无法确定用户主目录：{e}"))
}

pub(crate) fn open_pdf(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("无法打开 PDF：{e}"))
}
