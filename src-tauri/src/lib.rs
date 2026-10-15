mod appdir;
mod backup;
mod biblio;
mod io_util;
mod llm;
mod lookup;
mod lookup_run;
mod mineru;
mod mineru_api;
mod platform;
mod restore;
mod secrets;
#[cfg(test)]
mod test_util;
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
    let dest = copy_into_library(&library, &canon, &format!("{millis}-{stem}"))?;
    Ok(ImportedPdf {
        library_path: dest.to_string_lossy().to_string(),
        original_path: canon.to_string_lossy().to_string(),
    })
}

/// Copies `src` to `library/<base>.pdf` without ever replacing an existing
/// file: two imports with the same name in the same millisecond (a batch of
/// same-named PDFs from different folders) used to overwrite each other.
/// `create_new` makes the claim atomic; on a clash try `<base>-2.pdf`, `-3`, …
fn copy_into_library(library: &std::path::Path, src: &std::path::Path, base: &str) -> Result<PathBuf, String> {
    let mut input = fs::File::open(src).map_err(|err| format!("读取 PDF 失败：{err}"))?;
    for n in 1..=1000u32 {
        let name = if n == 1 { format!("{base}.pdf") } else { format!("{base}-{n}.pdf") };
        let dest = library.join(name);
        let mut out = match fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("复制 PDF 到文库失败：{e}")),
        };
        let copied = std::io::copy(&mut input, &mut out).and_then(|_| out.sync_all());
        if let Err(e) = copied {
            drop(out);
            let _ = fs::remove_file(&dest);
            return Err(format!("复制 PDF 到文库失败：{e}"));
        }
        return Ok(dest);
    }
    Err("复制 PDF 到文库失败：同名文件过多".into())
}

#[tauri::command]
fn export_files(root: String, files: Vec<ExportFile>) -> Result<(), String> {
    let root = PathBuf::from(root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for file in files {
        export_one(&root, &file.relative_path, file.content.as_bytes())?;
    }
    Ok(())
}

/// Writes `content` to `root/rel`, creating directories one level at a time.
/// Rejects absolute paths, `..`, `.`, and any symlink along the way.
fn export_one(root: &std::path::Path, rel: &str, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::path::Component;
    const INVALID: &str = "invalid export path";
    let comps: Vec<_> = std::path::Path::new(rel).components().collect();
    if comps.is_empty() {
        return Err(INVALID.into());
    }
    let mut cur = root.to_path_buf();
    for (i, c) in comps.iter().enumerate() {
        let Component::Normal(part) = c else { return Err(INVALID.into()) };
        cur.push(part);
        let last = i + 1 == comps.len();
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => return Err(INVALID.into()),
            Ok(m) if !last && !m.is_dir() => return Err(INVALID.into()),
            Ok(m) if last && m.is_dir() => return Err(INVALID.into()),
            Err(_) if !last => fs::create_dir(&cur).map_err(|e| e.to_string())?,
            _ => {}
        }
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut out = opts.open(&cur).map_err(|e| e.to_string())?;
    out.write_all(content).map_err(|e| e.to_string())
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
        // Copy com.paperfield.app → com.paperfield.notes before SQL preloads the database.
        .plugin(appdir::migration_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            biblio::biblio_settings,
            biblio::save_biblio_settings,
            backup::backup_database_file,
            backup::create_library_backup,
            restore::restore_library_backup,
            restore::restore_status,
            restore::restore_confirm_pending,
            restore::restore_commit_preview,
            restore::restore_list_pre,
            restore::restore_delete_pre,
            restore::restore_abandon,
            import_pdf_to_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paper Field");
}

#[cfg(test)]
mod tester_export_repro {
    use super::*;
    fn f(p: &str) -> ExportFile { ExportFile { relative_path: p.into(), content: "x".into() } }
    fn tmp(n: &str) -> PathBuf { crate::test_util::unique_temp_dir(&format!("pf-tester-{n}")) }
    #[test] fn e1_absolute_path_rejected_without_side_effect() {
        let base = tmp("e1"); let root = base.join("root"); let outside = base.join("outside");
        let r = export_files(root.to_string_lossy().into(), vec![f(&format!("{}/sub/a.md", outside.display()))]);
        assert!(r.is_err(), "absolute path should be rejected");
        assert!(!outside.exists(), "BUG: dir created outside root: {}", outside.display());
    }
    #[test] fn e2_dotdot_rejected() {
        let base = tmp("e2"); let root = base.join("root");
        assert!(export_files(root.to_string_lossy().into(), vec![f("../evil/a.md")]).is_err());
        assert!(!base.join("evil").exists());
    }
    #[test] fn e3_double_dot_in_filename_allowed() {
        let root = tmp("e3");
        export_files(root.to_string_lossy().into(), vec![f("a..b.md")]).expect("a..b.md is a legal filename");
        assert!(root.join("a..b.md").exists());
    }
    #[cfg(unix)] #[test] fn e4_symlink_escape_rejected() {
        let base = tmp("e4"); let root = base.join("root"); let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap(); fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let r = export_files(root.to_string_lossy().into(), vec![f("link/a.md")]);
        assert!(r.is_err() && !outside.join("a.md").exists(), "BUG: wrote through symlink to {}", outside.join("a.md").display());
    }
    #[test] fn e6_reexport_overwrites() {
        let root = tmp("e6");
        export_files(root.to_string_lossy().into(), vec![f("a.md")]).unwrap();
        export_files(root.to_string_lossy().into(), vec![ExportFile{relative_path:"a.md".into(),content:"new".into()}]).expect("re-export must succeed");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "new");
    }
    #[cfg(unix)] #[test] fn e7_final_symlink_file_rejected() {
        let base = tmp("e7"); let root = base.join("root"); fs::create_dir_all(&root).unwrap();
        fs::write(base.join("target.txt"), "orig").unwrap();
        std::os::unix::fs::symlink(base.join("target.txt"), root.join("a.md")).unwrap();
        assert!(export_files(root.to_string_lossy().into(), vec![f("a.md")]).is_err());
        assert_eq!(fs::read_to_string(base.join("target.txt")).unwrap(), "orig");
    }
    #[test] fn e5_nested_ok() {
        let root = tmp("e5");
        export_files(root.to_string_lossy().into(), vec![f("x/y/z.md")]).unwrap();
        assert_eq!(fs::read_to_string(root.join("x/y/z.md")).unwrap(), "x");
    }
}

#[cfg(test)]
mod export_tests {
    use super::export_one;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let base = crate::test_util::unique_temp_dir(&format!("pf-export-{name}"));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        (base, root.canonicalize().unwrap())
    }

    #[test]
    fn rejects_absolute_path_without_creating_dirs() {
        let (base, root) = scratch("e1");
        let outside = base.join("outside").join("a.md");
        assert!(export_one(&root, outside.to_str().unwrap(), b"x").is_err());
        assert!(!base.join("outside").exists());
    }

    #[test]
    fn rejects_parent_dir() {
        let (base, root) = scratch("e2");
        assert!(export_one(&root, "../outside/a.md", b"x").is_err());
        assert!(!base.join("outside").exists());
    }

    #[test]
    fn accepts_double_dot_inside_file_name() {
        let (_base, root) = scratch("e3");
        export_one(&root, "a..b.md", b"ok").unwrap();
        assert_eq!(fs::read(root.join("a..b.md")).unwrap(), b"ok");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directory() {
        let (base, root) = scratch("e4");
        fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), root.join("link")).unwrap();
        assert!(export_one(&root, "link/a.md", b"x").is_err());
        assert!(!base.join("outside/a.md").exists());
    }

    #[test]
    fn writes_nested_path() {
        let (_base, root) = scratch("e5");
        export_one(&root, "x/y/z.md", b"nested").unwrap();
        assert_eq!(fs::read(root.join("x/y/z.md")).unwrap(), b"nested");
    }

    #[test]
    fn overwrites_existing_file() {
        let (_base, root) = scratch("e6");
        export_one(&root, "a.md", b"one").unwrap();
        export_one(&root, "a.md", b"two").unwrap();
        assert_eq!(fs::read(root.join("a.md")).unwrap(), b"two");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_target_file() {
        let (base, root) = scratch("e7");
        fs::write(base.join("victim.md"), b"orig").unwrap();
        std::os::unix::fs::symlink(base.join("victim.md"), root.join("a.md")).unwrap();
        assert!(export_one(&root, "a.md", b"x").is_err());
        assert_eq!(fs::read(base.join("victim.md")).unwrap(), b"orig");
    }
}

#[cfg(test)]
mod import_tests {
    use super::copy_into_library;
    use std::fs;

    fn dir(n: &str) -> std::path::PathBuf {
        let d = crate::test_util::unique_temp_dir(&format!("pf-import-{n}"));
        fs::create_dir_all(d.join("lib")).unwrap();
        d
    }

    #[test]
    fn same_name_same_millisecond_never_overwrites() {
        let d = dir("clash");
        let (a, b) = (d.join("a.pdf"), d.join("b.pdf"));
        fs::write(&a, b"%PDF first").unwrap();
        fs::write(&b, b"%PDF second").unwrap();
        let lib = d.join("lib");
        let p1 = copy_into_library(&lib, &a, "1700000000000-paper").unwrap();
        let p2 = copy_into_library(&lib, &b, "1700000000000-paper").unwrap();
        let p3 = copy_into_library(&lib, &a, "1700000000000-paper").unwrap();
        assert_eq!(p1, lib.join("1700000000000-paper.pdf"));
        assert_eq!(p2, lib.join("1700000000000-paper-2.pdf"));
        assert_eq!(p3, lib.join("1700000000000-paper-3.pdf"));
        assert_eq!(fs::read(&p1).unwrap(), b"%PDF first");
        assert_eq!(fs::read(&p2).unwrap(), b"%PDF second");
    }

    #[cfg(unix)]
    #[test]
    fn planted_symlink_at_target_is_skipped_not_written_through() {
        let d = dir("link");
        let src = d.join("s.pdf");
        fs::write(&src, b"%PDF data").unwrap();
        let bait = d.join("bait");
        fs::write(&bait, b"keep").unwrap();
        std::os::unix::fs::symlink(&bait, d.join("lib").join("x.pdf")).unwrap();
        let p = copy_into_library(&d.join("lib"), &src, "x").unwrap();
        assert_eq!(p, d.join("lib").join("x-2.pdf"));
        assert_eq!(fs::read(&bait).unwrap(), b"keep");
    }
}
