use std::path::Path;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub(crate) fn home_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("", BaseDirectory::Home)
        .map_err(|e| format!("无法确定用户主目录：{e}"))
}

/// Top-level webview navigation. External https is rejected; the app origin is allowed.
pub(crate) fn allow_top_level_navigation(url: &url::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    if matches!(url.scheme(), "http" | "https") && matches!(host, "tauri.localhost" | "ipc.localhost") {
        return true;
    }
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") && url.port() == Some(43173) {
        return true;
    }
    false
}

pub(crate) fn open_pdf(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("无法打开 PDF：{e}"))
}

#[cfg(test)]
mod tests {
    use super::allow_top_level_navigation;

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
}
