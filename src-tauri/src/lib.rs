mod appdir;
mod applog;
mod backup;
mod biblio;
mod db;
mod instance;
mod io_util;
mod library;
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

/// `source` 必须是本次运行系统对话框选中的 PDF（见 mineru::pick_pdf_files / pick_pdf_folder）
/// 或文库里的文件；任意路径一律拒绝。
#[tauri::command]
async fn import_pdf_to_library(
    app: tauri::AppHandle,
    grants: tauri::State<'_, library::PdfGrants>,
    source: String,
) -> Result<ImportedPdf, String> {
    let config = app_config_dir(&app)?;
    let src = library::authorize_pdf(&config, &grants, &source)?;
    import_pdf_at(config, src).await
}

/// Waits for the restore lock (an abandon may be moving files back into
/// `library/`), then copies off the async worker.
async fn import_pdf_at(config: PathBuf, src: PathBuf) -> Result<ImportedPdf, String> {
    let _guard = restore::OP_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || import_pdf_locked(&config, &src))
        .await
        .map_err(|err| err.to_string())?
}

fn import_pdf_locked(config: &std::path::Path, src: &std::path::Path) -> Result<ImportedPdf, String> {
    if !src.is_file() {
        return Err("PDF 不存在".into());
    }
    let canon = dunce::canonicalize(src).map_err(|err| err.to_string())?;
    let is_pdf = canon
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err("请选择 PDF 文件".into());
    }
    let library = config.join("library");
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
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "复制 PDF 到文库失败：文件名无效".to_string())?;
    Ok(ImportedPdf {
        // 文库内只存相对名：换机恢复、数据目录搬家后链接仍有效（见 library.rs）。
        library_path: library::stored_name(file_name),
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

/// 弹出选择文件夹对话框后导出；用户取消时返回 None。根目录只来自系统对话框。
#[tauri::command]
async fn export_files(app: tauri::AppHandle, files: Vec<ExportFile>) -> Result<Option<String>, String> {
    let Some(root) = platform::pick_path(&app, "导出领域笔记", platform::PickKind::Folder).await? else {
        return Ok(None);
    };
    let root = root.to_string_lossy().to_string();
    let target = root.clone();
    tauri::async_runtime::spawn_blocking(move || export_files_at(target, files))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(root))
}

fn export_files_at(root: String, files: Vec<ExportFile>) -> Result<(), String> {
    // 先整体校验再写：不让一半文件落盘后才发现某个名字不合法。
    if let Some(bad) = files.iter().find(|file| !is_markdown_name(&file.relative_path)) {
        return Err(format!("导出文件名无效：{}（只能导出 .md 文件）", bad.relative_path));
    }
    let root = PathBuf::from(root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for file in files {
        export_one(&root, &file.relative_path, file.content.as_bytes())?;
    }
    Ok(())
}

/// 导出只产出 Markdown（export.ts 的 README.md 与各论文 .md）：名字与内容来自渲染进程，
/// 扩展名固定为 .md，免得被拿来往用户选的目录里写 .command / .app 之类可执行文件。
fn is_markdown_name(rel: &str) -> bool {
    // `:` 一律拒绝：NTFS 上 `x.bat:.md` 是 x.bat 的备用数据流。
    !rel.contains(':')
        && std::path::Path::new(rel)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// Writes `content` to `root/rel`, creating directories one level at a time.
/// Rejects absolute paths, `..`, `.`, and any symlink along the way. Never
/// replaces an existing file (each export goes to a fresh timestamped folder;
/// a clash means the user picked a folder that already holds one).
fn export_one(root: &std::path::Path, rel: &str, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::path::Component;
    const INVALID: &str = "invalid export path";
    let comps: Vec<_> = std::path::Path::new(rel).components().collect();
    if comps.is_empty() || !is_markdown_name(rel) {
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
    // create_new：已有同名文件（或任何东西，含悬空符号链接）时失败，绝不截断用户已有的文件。
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut out = opts.open(&cur).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("导出目录里已有同名文件，未覆盖：{rel}"),
        _ => e.to_string(),
    })?;
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

fn navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("paper-field-navigation")
        .on_navigation(|webview, url| webview.label() != "main" || platform::allow_top_level_navigation(url))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：第二次启动只把已有窗口带到前台然后退出，不跑任何启动任务。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Copy com.paperfield.app → com.paperfield.notes before the database layer opens it.
        .plugin(appdir::migration_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(navigation_plugin())
        .manage(db::Db::default())
        .manage(llm::LlmState::new())
        .manage(mineru::MineruCredBook::default())
        .manage(library::PdfGrants::default())
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
            db::db_select,
            db::db_execute,
            db::db_batch,
            db::db_close,
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
            mineru::pick_pdf_files,
            mineru::pick_pdf_folder,
            mineru::open_pdf,
            mineru::mineru_current_fingerprint,
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
            appdir::appdir_migration_notices,
            applog::app_log_read,
            applog::app_log_write,
            applog::app_log_clear,
            platform::reveal_pre_restore,
            import_pdf_to_library
        ])
        .build(tauri::generate_context!())
        .expect("error while running Paper Field")
        .run(|app, event| {
            // 退出前关闭连接池：最后一个连接关闭时 SQLite 做检查点，不留 -wal。
            // 再放掉文库锁：重启（恢复文库、安装更新）的新进程紧接着就要拿它。
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(app.state::<db::Db>().close());
                instance::release();
            }
        });
}

#[cfg(test)]
mod tester_export_repro {
    use super::*;
    fn f(p: &str) -> ExportFile { ExportFile { relative_path: p.into(), content: "x".into() } }
    fn tmp(n: &str) -> PathBuf { crate::test_util::unique_temp_dir(&format!("pf-tester-{n}")) }
    #[test] fn e1_absolute_path_rejected_without_side_effect() {
        let base = tmp("e1"); let root = base.join("root"); let outside = base.join("outside");
        let r = export_files_at(root.to_string_lossy().into(), vec![f(&format!("{}/sub/a.md", outside.display()))]);
        assert!(r.is_err(), "absolute path should be rejected");
        assert!(!outside.exists(), "BUG: dir created outside root: {}", outside.display());
    }
    #[test] fn e2_dotdot_rejected() {
        let base = tmp("e2"); let root = base.join("root");
        assert!(export_files_at(root.to_string_lossy().into(), vec![f("../evil/a.md")]).is_err());
        assert!(!base.join("evil").exists());
    }
    #[test] fn e3_double_dot_in_filename_allowed() {
        let root = tmp("e3");
        export_files_at(root.to_string_lossy().into(), vec![f("a..b.md")]).expect("a..b.md is a legal filename");
        assert!(root.join("a..b.md").exists());
    }
    #[cfg(unix)] #[test] fn e4_symlink_escape_rejected() {
        let base = tmp("e4"); let root = base.join("root"); let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap(); fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let r = export_files_at(root.to_string_lossy().into(), vec![f("link/a.md")]);
        assert!(r.is_err() && !outside.join("a.md").exists(), "BUG: wrote through symlink to {}", outside.join("a.md").display());
    }
    #[test] fn e6_reexport_never_overwrites() {
        let root = tmp("e6");
        export_files_at(root.to_string_lossy().into(), vec![f("a.md")]).unwrap();
        let r = export_files_at(root.to_string_lossy().into(), vec![ExportFile{relative_path:"a.md".into(),content:"new".into()}]);
        assert!(r.unwrap_err().contains("未覆盖"));
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "x");
    }
    #[test] fn e8_non_markdown_rejected_before_any_write() {
        let root = tmp("e8");
        for bad in ["evil.command", "x/run.sh", "a.md.exe", "noext", "x/.md/a"] {
            let r = export_files_at(root.to_string_lossy().into(), vec![f("ok/a.md"), f(bad)]);
            assert!(r.is_err(), "{bad}");
        }
        assert!(!root.join("ok").exists(), "nothing written when one name is invalid");
        export_files_at(root.to_string_lossy().into(), vec![f("x/README.MD")]).expect("case-insensitive .md");
    }
    #[cfg(unix)] #[test] fn e7_final_symlink_file_rejected() {
        let base = tmp("e7"); let root = base.join("root"); fs::create_dir_all(&root).unwrap();
        fs::write(base.join("target.txt"), "orig").unwrap();
        std::os::unix::fs::symlink(base.join("target.txt"), root.join("a.md")).unwrap();
        assert!(export_files_at(root.to_string_lossy().into(), vec![f("a.md")]).is_err());
        assert_eq!(fs::read_to_string(base.join("target.txt")).unwrap(), "orig");
    }
    #[test] fn e5_nested_ok() {
        let root = tmp("e5");
        export_files_at(root.to_string_lossy().into(), vec![f("x/y/z.md")]).unwrap();
        assert_eq!(fs::read_to_string(root.join("x/y/z.md")).unwrap(), "x");
    }
}

#[cfg(test)]
mod export_tests {
    use super::{export_one, is_markdown_name};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn markdown_names_reject_alternate_data_streams() {
        assert!(is_markdown_name("MM-01/README.md") && is_markdown_name("a/B.MD"));
        for bad in ["x.bat:.md", "a/x.md:evil", "C:x.md", "x.txt"] {
            assert!(!is_markdown_name(bad), "{bad}");
        }
    }

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
    fn never_overwrites_existing_file() {
        let (_base, root) = scratch("e6");
        export_one(&root, "a.md", b"one").unwrap();
        assert!(export_one(&root, "a.md", b"two").is_err());
        assert_eq!(fs::read(root.join("a.md")).unwrap(), b"one");
    }

    #[test]
    fn rejects_non_markdown_extension() {
        let (_base, root) = scratch("e8");
        assert!(export_one(&root, "a.command", b"x").is_err());
        assert!(!root.join("a.command").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink_target() {
        let (base, root) = scratch("e9");
        std::os::unix::fs::symlink(base.join("created-elsewhere.md"), root.join("a.md")).unwrap();
        assert!(export_one(&root, "a.md", b"x").is_err());
        assert!(!base.join("created-elsewhere.md").exists());
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
    fn import_waits_while_abandon_holds_lock() {
        let d = dir("lock");
        let src = d.join("p.pdf");
        fs::write(&src, b"%PDF x").unwrap();
        let guard = crate::restore::OP_LOCK.blocking_lock();
        let (cfg, s2) = (d.join("cfg"), src.clone());
        let h = std::thread::spawn(move || tauri::async_runtime::block_on(super::import_pdf_at(cfg, s2)));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!h.is_finished(), "import must wait for the restore lock");
        assert!(!d.join("cfg").join("library").exists(), "nothing written while waiting");
        drop(guard);
        let got = h.join().unwrap().unwrap();
        assert!(got.library_path.starts_with("library/"), "stored relative: {}", got.library_path);
        let grants = crate::library::PdfGrants::default();
        let stored = crate::library::authorize_pdf(&d.join("cfg"), &grants, &got.library_path).unwrap();
        assert_eq!(fs::read(stored).unwrap(), b"%PDF x");
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
