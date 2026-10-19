use std::path::Path;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

/// 读写文件的对话框都在 Rust 侧弹出：命令只用用户在系统对话框里选的路径，
/// 不再接受渲染进程传来的任意路径（页面被注入脚本时也无法借备份 / 导出写到别处）。
pub(crate) enum PickKind<'a> {
    SaveFile { default_name: &'a str, filter: (&'a str, &'a [&'a str]) },
    OpenFile { filter: (&'a str, &'a [&'a str]) },
    Folder,
}

pub(crate) async fn pick_path(app: &AppHandle, title: &str, kind: PickKind<'_>) -> Result<Option<std::path::PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    let builder = app.dialog().file().set_title(title);
    match kind {
        PickKind::SaveFile { default_name, filter } => builder
            .set_file_name(default_name)
            .add_filter(filter.0, filter.1)
            .save_file(move |path| {
                let _ = tx.send(path);
            }),
        PickKind::OpenFile { filter } => builder.add_filter(filter.0, filter.1).pick_file(move |path| {
            let _ = tx.send(path);
        }),
        PickKind::Folder => builder.pick_folder(move |path| {
            let _ = tx.send(path);
        }),
    }
    match rx.await.map_err(|_| "对话框已关闭".to_string())? {
        Some(path) => path.into_path().map(Some).map_err(|err| err.to_string()),
        None => Ok(None),
    }
}

/// 多选文件；用户取消时返回 None。
pub(crate) async fn pick_paths(
    app: &AppHandle,
    title: &str,
    filter: (&str, &[&str]),
) -> Result<Option<Vec<std::path::PathBuf>>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(filter.0, filter.1)
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    match rx.await.map_err(|_| "对话框已关闭".to_string())? {
        Some(paths) => paths
            .into_iter()
            .map(|path| path.into_path().map_err(|err| err.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        None => Ok(None),
    }
}

pub(crate) fn home_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("", BaseDirectory::Home)
        .map_err(|e| format!("无法确定用户主目录：{e}"))
}

/// Top-level webview navigation. External https is rejected; the app origin is allowed.
/// macOS / Linux 上应用源是 `tauri://localhost`：只认这个主机，`tauri://别的主机` 不放行。
pub(crate) fn allow_top_level_navigation(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    if url.scheme() == "tauri" {
        return host == "localhost" && url.port().is_none();
    }
    if matches!(url.scheme(), "http" | "https") && matches!(host, "tauri.localhost" | "ipc.localhost") {
        return true;
    }
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") && url.port() == Some(43173) {
        return true;
    }
    false
}

/// 在文件管理器里显示恢复前的原数据目录。路径只取自 Rust 侧记下的恢复状态，
/// 且必须是数据目录下的 `pre-restore-<数字>`：渲染进程不再持有「显示任意路径」的权限。
#[tauri::command]
pub(crate) fn reveal_pre_restore(app: AppHandle) -> Result<(), String> {
    let pre = match crate::restore::restore_status() {
        crate::restore::RestoreStatus::Restored { pre, .. }
        | crate::restore::RestoreStatus::RolledBack { pre }
        | crate::restore::RestoreStatus::Stuck { pre, .. } => pre,
        _ => String::new(),
    };
    let dir = pre_restore_dir(&crate::app_config_dir(&app)?, &pre).ok_or("没有可打开的原数据目录")?;
    app.opener()
        .reveal_item_in_dir(&dir)
        .map_err(|e| format!("无法打开原数据目录：{e}"))
}

fn pre_restore_dir(config_dir: &Path, pre: &str) -> Option<std::path::PathBuf> {
    let path = Path::new(pre);
    let name = path.file_name()?.to_str()?;
    let digits = name.strip_prefix("pre-restore-")?;
    let valid = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) && path.parent() == Some(config_dir);
    valid.then(|| path.to_path_buf())
}

pub(crate) fn open_pdf(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("无法打开 PDF：{e}"))
}

#[cfg(test)]
mod tests {
    use super::{allow_top_level_navigation, pre_restore_dir};
    use std::path::{Path, PathBuf};

    fn url(raw: &str) -> url::Url {
        url::Url::parse(raw).unwrap()
    }

    #[test]
    fn external_https_is_rejected_and_the_app_origin_is_allowed() {
        assert!(!allow_top_level_navigation(&url("https://example.com/")));
        assert!(!allow_top_level_navigation(&url("http://example.com/paper")));
        assert!(allow_top_level_navigation(&url("tauri://localhost/")));
        assert!(allow_top_level_navigation(&url("http://tauri.localhost/")));
        assert!(allow_top_level_navigation(&url("https://tauri.localhost/index.html")));
        assert!(allow_top_level_navigation(&url("https://ipc.localhost/")));
        assert!(allow_top_level_navigation(&url("http://127.0.0.1:43173/")));
        assert!(allow_top_level_navigation(&url("http://localhost:43173/")));
        assert!(!allow_top_level_navigation(&url("https://127.0.0.1:43173/")));
        assert!(!allow_top_level_navigation(&url("http://127.0.0.1:80/")));
    }

    #[test]
    fn tauri_scheme_is_allowed_only_for_localhost() {
        assert!(allow_top_level_navigation(&url("tauri://localhost/index.html")));
        assert!(!allow_top_level_navigation(&url("tauri://evil.example/")));
        assert!(!allow_top_level_navigation(&url("tauri://localhost.evil.example/")));
        assert!(!allow_top_level_navigation(&url("tauri://localhost:8080/")));
        assert!(!allow_top_level_navigation(&url("tauri:evil")));
    }

    #[test]
    fn reveal_accepts_only_pre_restore_dirs_inside_the_data_dir() {
        let config = Path::new("/data/com.paperfield.notes");
        let pre = config.join("pre-restore-1700");
        assert_eq!(pre_restore_dir(config, &pre.to_string_lossy()), Some(pre));
        for bad in [
            String::new(),
            "/data/com.paperfield.notes/library".into(),
            "/data/com.paperfield.notes/pre-restore-".into(),
            "/data/com.paperfield.notes/pre-restore-1x".into(),
            "/elsewhere/pre-restore-1700".into(),
            "/data/com.paperfield.notes/sub/pre-restore-1700".into(),
            "pre-restore-1700".into(),
        ] {
            assert_eq!(pre_restore_dir(config, &bad), None::<PathBuf>, "{bad}");
        }
    }
}
