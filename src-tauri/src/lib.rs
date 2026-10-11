mod backup;
mod io_util;
mod llm;
mod lookup;
mod mineru;
mod mineru_api;
mod platform;
mod secrets;
mod transport;

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    relative_path: String,
    content: String,
}

pub(crate) fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resolve("", BaseDirectory::AppConfig)
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedPdf {
    library_path: String,
    original_path: String,
}

#[tauri::command]
fn import_pdf_to_library(app: tauri::AppHandle, source: String) -> Result<ImportedPdf, String> {
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err("PDF 不存在".into());
    }
    let canon = dunce::canonicalize(&src).map_err(|err| err.to_string())?;
    let is_pdf = canon
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err("请选择 PDF 文件".into());
    }
    let library = app_config_dir(&app)?.join("library");
    fs::create_dir_all(&library).map_err(|err| err.to_string())?;
    let stem = canon
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("paper")
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let dest = library.join(format!("{millis}-{stem}.pdf"));
    fs::copy(&canon, &dest).map_err(|err| format!("复制 PDF 到文库失败：{err}"))?;
    Ok(ImportedPdf {
        library_path: dest.to_string_lossy().to_string(),
        original_path: canon.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn export_files(root: String, files: Vec<ExportFile>) -> Result<(), String> {
    let root = PathBuf::from(root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for file in files {
        if file.relative_path.contains("..") {
            return Err("invalid export path".into());
        }
        let dest = root.join(&file.relative_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if !dest.starts_with(&root) {
            return Err("invalid export path".into());
        }
        fs::write(dest, file.content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let new_paper = MenuItemBuilder::with_id("new-paper", "New Paper")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_domain = MenuItemBuilder::with_id("new-domain", "New Domain")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let mark_read = MenuItemBuilder::with_id("mark-read", "Mark Read")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_paper)
        .item(&new_domain)
        .separator()
        .item(&mark_read)
        .separator()
        .quit()
        .build()?;
    let field = MenuItemBuilder::with_id("mode-field", "FIELD 现场").build(app)?;
    let archive = MenuItemBuilder::with_id("mode-archive", "ARCHIVE 归档").build(app)?;
    let intake = MenuItemBuilder::with_id("mode-intake", "INTAKE 入库").build(app)?;
    let system = MenuItemBuilder::with_id("mode-system", "SYSTEM 系统").build(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&field)
        .item(&archive)
        .item(&intake)
        .item(&system)
        .build()?;
    // macOS 的 ⌘C/⌘V/⌘A/⌘Z 由菜单栏 Edit 菜单提供键等效；缺了这些预置项，
    // 文本框里的复制/粘贴/全选快捷键会全部失效。
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    MenuBuilder::new(app).item(&file).item(&edit).item(&view).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(llm::LlmState::new())
        .setup(|app| {
            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            let _ = app.emit("menu://action", id);
        })
        .invoke_handler(tauri::generate_handler![
            llm::llm_settings,
            llm::save_llm_settings,
            llm::llm_test,
            llm::llm_list_models,
            llm::llm_complete,
            llm::llm_cancel,
            export_files,
            mineru::mineru_settings,
            mineru::save_mineru_settings,
            mineru::mineru_test,
            mineru::mineru_probe,
            mineru::list_pdfs,
            mineru::normalize_pdf,
            mineru::open_pdf,
            mineru::mineru_submit,
            mineru::mineru_parse_statuses,
            mineru::mineru_markdown,
            lookup::lookup_paper,
            lookup::verify_url,
            backup::backup_database_file,
            backup::create_library_backup,
            backup::restore_library_backup,
            import_pdf_to_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paper Field");
}
