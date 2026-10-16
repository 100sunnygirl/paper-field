//! Zip backup of the database, the library PDFs, and non-secret settings.
//! Restore copies the current database aside before replacing anything.
//! The zip is written beside `dest` and renamed over it only once complete;
//! its last entry, `manifest.json`, lets restore spot a backup missing PDFs.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::app_config_dir;
use crate::secrets::scrub_json_secrets;

pub(crate) const MANIFEST: &str = "manifest.json";

fn stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_dir(app)
}

pub fn database_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("paper-field.db"))
}

fn copy_sqlite_family(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::copy(src, dest).map_err(|err| format!("复制数据库失败：{err}"))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let extra = PathBuf::from(format!("{}{suffix}", src.display()));
        if extra.exists() {
            let dest_extra = PathBuf::from(format!("{}{suffix}", dest.display()));
            fs::copy(&extra, &dest_extra).map_err(|err| format!("复制数据库日志失败：{err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_database_file(app: AppHandle) -> Result<String, String> {
    backup_database_at(database_file(&app)?).await
}

/// Holds the restore lock so an abandon can't swap the database mid-copy.
async fn backup_database_at(db: PathBuf) -> Result<String, String> {
    let _guard = crate::restore::OP_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || copy_database_aside(&db))
        .await
        .map_err(|err| err.to_string())?
}

fn copy_database_aside(src: &Path) -> Result<String, String> {
    if !src.exists() {
        return Ok(String::new());
    }
    let dest = src.with_file_name(format!("paper-field.db.premigrate-{}", stamp()));
    copy_sqlite_family(src, &dest)?;
    Ok(dest.display().to_string())
}

/// Returns whether the file existed and was added.
fn add_file(zip: &mut ZipWriter<File>, options: SimpleFileOptions, name: &str, path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    zip.start_file(name, options).map_err(|err| err.to_string())?;
    // Stream: a large PDF is never held in memory whole.
    std::io::copy(&mut file, zip).map_err(|err| err.to_string())?;
    Ok(true)
}

fn add_scrubbed_settings(zip: &mut ZipWriter<File>, options: SimpleFileOptions, name: &str, path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let scrubbed = scrub_json_secrets(&raw);
    zip.start_file(name, options).map_err(|err| err.to_string())?;
    zip.write_all(scrubbed.as_bytes()).map_err(|err| err.to_string())?;
    Ok(true)
}

/// 弹出保存对话框后写备份；用户取消时返回 None。路径只来自系统对话框。
#[tauri::command]
pub async fn create_library_backup(app: AppHandle) -> Result<Option<String>, String> {
    let kind = crate::platform::PickKind::SaveFile {
        default_name: "paper-field-backup.zip",
        filter: ("Zip", &["zip"]),
    };
    let Some(dest) = crate::platform::pick_path(&app, "备份文库", kind).await? else {
        return Ok(None);
    };
    let dest = dest.to_string_lossy().to_string();
    backup_at(config_dir(&app)?, dest.clone()).await?;
    Ok(Some(dest))
}

/// Holds the restore lock so an abandon can't move files back into
/// `library/` (or swap the database) while the zip is being written.
async fn backup_at(dir: PathBuf, dest: String) -> Result<(), String> {
    let _guard = crate::restore::OP_LOCK.lock().await;
    let db = dir.join("paper-field.db");
    let snap = dir.join(format!(".backup-snapshot-{}.db", stamp()));
    if db.exists() {
        snapshot_database(&db, &snap).await?;
    }
    let snap2 = snap.clone();
    let result = tauri::async_runtime::spawn_blocking(move || write_backup_zip(&dir, &snap2, &dest))
        .await
        .map_err(|err| err.to_string())
        .and_then(|r| r);
    let _ = fs::remove_file(&snap);
    result
}

/// Consistent copy of the live database via `VACUUM INTO`, independent of WAL state.
async fn snapshot_database(db: &Path, snap: &Path) -> Result<(), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let options = SqliteConnectOptions::new()
        .filename(db)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| format!("打开数据库失败：{err}"))?;
    let result = sqlx::query("VACUUM INTO ?")
        .bind(snap.to_string_lossy().to_string())
        .execute(&pool)
        .await
        .map(|_| ())
        .map_err(|err| format!("生成数据库快照失败：{err}"));
    pool.close().await;
    if result.is_err() {
        let _ = fs::remove_file(snap);
    }
    result
}

/// Removes `.backup-snapshot-*.db` files left behind by a crash mid-backup.
pub fn cleanup_backup_snapshots(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".backup-snapshot-") && name.ends_with(".db") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `<dest>.partial` (or `.partial-<n>` if taken), created fresh beside `dest`
/// so the final rename stays on one filesystem.
fn create_partial(dest: &Path) -> Result<(PathBuf, File), String> {
    let mut n = 0u32;
    loop {
        let mut name = dest.as_os_str().to_os_string();
        name.push(if n == 0 { ".partial".to_string() } else { format!(".partial-{n}") });
        let tmp = PathBuf::from(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists && n < 1000 => n += 1,
            Err(err) => return Err(format!("无法创建备份：{err}")),
        }
    }
}

/// The previous backup at `dest` stays intact until the new one is complete
/// and synced; on any error the partial file is removed.
fn write_backup_zip(dir: &Path, snap: &Path, dest: &str) -> Result<(), String> {
    let dest = Path::new(dest);
    let (tmp, file) = create_partial(dest)?;
    let result = fill_backup_zip(dir, snap, file)
        .and_then(|()| fs::rename(&tmp, dest).map_err(|err| format!("保存备份失败：{err}")));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn fill_backup_zip(dir: &Path, snap: &Path, file: File) -> Result<(), String> {
    // On error the writer's Drop still finishes a valid-looking zip: the caller deletes it.
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    add_file(&mut zip, options, "paper-field.db", snap)?;
    let mut pdfs = 0usize;
    let library = dir.join("library");
    if library.is_dir() {
        for entry in fs::read_dir(&library).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("pdf")) != Some(true) {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains("..") || name.contains('/') || name.contains('\\') {
                continue;
            }
            if add_file(&mut zip, options, &format!("library/{name}"), &path)? {
                pdfs += 1;
            }
        }
    }
    let mut settings = Vec::new();
    for (name, scrub) in [("llm-settings.json", true), ("mineru-settings.json", true), ("biblio-settings.json", false)] {
        let (entry, path) = (format!("settings/{name}"), dir.join(name));
        let added = if scrub {
            add_scrubbed_settings(&mut zip, options, &entry, &path)?
        } else {
            add_file(&mut zip, options, &entry, &path)?
        };
        if added {
            settings.push(name);
        }
    }
    // Last entry, so a zip that has it got everything before it.
    let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let manifest = serde_json::json!({
        "format": 1,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "createdAt": created_ms,
        "pdfs": pdfs,
        "settings": settings,
    });
    zip.start_file(MANIFEST, options).map_err(|err| err.to_string())?;
    zip.write_all(manifest.to_string().as_bytes()).map_err(|err| err.to_string())?;
    let file = zip.finish().map_err(|err| format!("完成备份失败：{err}"))?;
    file.sync_all().map_err(|err| format!("写入备份失败：{err}"))
}

pub(crate) fn safe_entry_name(name: &str) -> Option<&str> {
    if name.is_empty() || name.starts_with('/') || name.starts_with('\\') || name.contains("..") {
        return None;
    }
    let normalized = name.replace('\\', "/");
    if normalized.split('/').any(|part| part == ".." || part.is_empty() && normalized.contains("//")) {
        return None;
    }
    Some(name)
}

#[cfg(test)]
mod tester_backup_b1 {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use sqlx::Row;
    fn tmp(n: &str) -> PathBuf { crate::test_util::unique_temp_dir(&format!("pf-tester-{n}")) }

    #[test] fn b1_snapshot_includes_uncheckpointed_wal_writes() {
        tauri::async_runtime::block_on(async {
            let d = tmp("b1"); let db = d.join("paper-field.db"); let snap = d.join("snap.db");
            let opts = SqliteConnectOptions::new().filename(&db).create_if_missing(true).journal_mode(SqliteJournalMode::Wal);
            let live = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
            sqlx::query("PRAGMA wal_autocheckpoint=0").execute(&live).await.unwrap();
            sqlx::query("CREATE TABLE papers(id INTEGER PRIMARY KEY, t TEXT)").execute(&live).await.unwrap();
            for i in 0..50 { sqlx::query("INSERT INTO papers(t) VALUES (?)").bind(format!("p{i}")).execute(&live).await.unwrap(); }
            let wal = fs::metadata(d.join("paper-field.db-wal")).map(|m| m.len()).unwrap_or(0);
            assert!(wal > 0, "precondition: WAL must hold uncheckpointed data");
            // live connection still open, WAL not checkpointed
            snapshot_database(&db, &snap).await.expect("snapshot");
            let s = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&snap).read_only(true)).await.unwrap();
            let n: i64 = sqlx::query("SELECT count(*) c FROM papers").fetch_one(&s).await.unwrap().get("c");
            let ic: String = sqlx::query("PRAGMA integrity_check").fetch_one(&s).await.unwrap().get(0);
            eprintln!("B1 wal_bytes={wal} snapshot_rows={n} integrity={ic}");
            assert_eq!(n, 50); assert_eq!(ic, "ok");
            // the raw main file alone (old behaviour) would miss them
            let raw = d.join("raw.db"); fs::copy(&db, &raw).unwrap();
            let r = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&raw).read_only(true)).await;
            let raw_rows: i64 = match r { Ok(p) => sqlx::query("SELECT count(*) c FROM papers").fetch_one(&p).await.map(|x| x.get("c")).unwrap_or(-1), Err(_) => -1 };
            eprintln!("B1 old-behaviour raw copy rows={raw_rows} (-1 = table missing)");
        });
    }

    #[test] fn b3_missing_db_not_created() {
        tauri::async_runtime::block_on(async {
            let d = tmp("b3"); let db = d.join("paper-field.db"); let snap = d.join("snap.db");
            assert!(snapshot_database(&db, &snap).await.is_err());
            assert!(!db.exists(), "BUG: empty db created"); assert!(!snap.exists());
        });
    }

    #[test] fn b5_backup_waits_while_abandon_holds_lock() {
        let d = tmp("b5");
        fs::create_dir_all(d.join("library")).unwrap();
        fs::write(d.join("library").join("a.pdf"), b"%PDF a").unwrap();
        let dest = d.join("out.zip");
        // abandon_restore holds this lock while it moves files back into library/.
        let guard = crate::restore::OP_LOCK.blocking_lock();
        let (d2, dest2) = (d.clone(), dest.to_string_lossy().into_owned());
        let h = std::thread::spawn(move || tauri::async_runtime::block_on(backup_at(d2, dest2)));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!h.is_finished(), "backup must wait for the restore lock");
        assert!(!dest.exists(), "nothing written while waiting");
        drop(guard);
        h.join().unwrap().unwrap();
        assert!(dest.exists());
    }

    #[test] fn b7_db_copy_waits_while_abandon_holds_lock() {
        let d = tmp("b7");
        fs::write(d.join("paper-field.db"), b"db").unwrap();
        fs::write(d.join("paper-field.db-wal"), b"wal").unwrap();
        fs::write(d.join("paper-field.db-shm"), b"shm").unwrap();
        let copies = |d: &Path| fs::read_dir(d).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("paper-field.db.premigrate-")).count();
        // While waiting nothing at all may be copied: not the db, nor its -wal / -shm.
        let guard = crate::restore::OP_LOCK.blocking_lock();
        let d2 = d.clone();
        let h = std::thread::spawn(move || tauri::async_runtime::block_on(backup_database_at(d2.join("paper-field.db"))));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!h.is_finished(), "db copy must wait for the restore lock");
        assert_eq!(copies(&d), 0, "nothing copied while waiting");
        drop(guard);
        let out = h.join().unwrap().unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"db");
        assert_eq!(fs::read(format!("{out}-wal")).unwrap(), b"wal");
        assert_eq!(fs::read(format!("{out}-shm")).unwrap(), b"shm");
        assert_eq!(copies(&d), 3, "db, -wal and -shm copied once each");
        // No database yet: nothing to copy, empty path.
        assert_eq!(tauri::async_runtime::block_on(backup_database_at(tmp("b7-none").join("paper-field.db"))).unwrap(), "");
    }

    #[test] fn b6_backup_round_trip_keeps_bytes() {
        use std::io::Read;
        let d = tmp("b6");
        fs::create_dir_all(d.join("library")).unwrap();
        // Larger than io::copy's buffer so streaming really takes several chunks.
        let big: Vec<u8> = (0..300_000u32).map(|i| (i * 31 % 251) as u8).collect();
        fs::write(d.join("library").join("big.pdf"), &big).unwrap();
        fs::write(d.join("library").join("small.PDF"), b"%PDF s").unwrap();
        fs::write(d.join("library").join("skip.txt"), b"no").unwrap();
        let dest = d.join("out.zip");
        tauri::async_runtime::block_on(backup_at(d.clone(), dest.to_string_lossy().into_owned())).unwrap();
        let mut z = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let mut read = |n: &str| { let mut v = Vec::new(); z.by_name(n).unwrap().read_to_end(&mut v).unwrap(); v };
        assert_eq!(read("library/big.pdf"), big);
        assert_eq!(read("library/small.PDF"), b"%PDF s");
        assert!(z.by_name("library/skip.txt").is_err());
        assert!(fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".backup-snapshot-")));
    }

    fn partials(d: &Path) -> Vec<String> {
        fs::read_dir(d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".partial")).collect()
    }

    #[test] fn b8_failed_backup_keeps_previous_zip_and_leaves_no_partial() {
        let d = tmp("b8");
        fs::create_dir_all(d.join("library")).unwrap();
        fs::write(d.join("library").join("a.pdf"), b"%PDF a").unwrap();
        // A directory named like a PDF: reading it fails halfway through the zip.
        fs::create_dir_all(d.join("library").join("broken.pdf")).unwrap();
        let dest = d.join("out.zip");
        fs::write(&dest, b"previous backup").unwrap();
        assert!(tauri::async_runtime::block_on(backup_at(d.clone(), dest.to_string_lossy().into_owned())).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"previous backup", "old backup untouched");
        assert!(partials(&d).is_empty(), "{:?}", partials(&d));
    }

    #[test] fn b9_backup_replaces_dest_and_ends_with_manifest() {
        let d = tmp("b9");
        fs::create_dir_all(d.join("library")).unwrap();
        fs::write(d.join("library").join("a.pdf"), b"%PDF a").unwrap();
        fs::write(d.join("library").join("b.PDF"), b"%PDF b").unwrap();
        fs::write(d.join("biblio-settings.json"), b"{}").unwrap();
        let dest = d.join("out.zip");
        fs::write(&dest, b"previous backup").unwrap();
        // Someone else's file on the first temp name: never reused or deleted.
        fs::write(d.join("out.zip.partial"), b"not ours").unwrap();
        tauri::async_runtime::block_on(backup_at(d.clone(), dest.to_string_lossy().into_owned())).unwrap();
        assert_eq!(fs::read(d.join("out.zip.partial")).unwrap(), b"not ours");
        assert_eq!(partials(&d), vec!["out.zip.partial".to_string()]);
        let mut z = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let last = z.by_index(z.len() - 1).unwrap();
        assert_eq!(last.name(), MANIFEST, "manifest is the last entry");
        let m: serde_json::Value = serde_json::from_reader(last).unwrap();
        assert_eq!((m["format"].as_u64(), m["pdfs"].as_u64()), (Some(1), Some(2)));
        assert_eq!(m["appVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(m["settings"], serde_json::json!(["biblio-settings.json"]));
        assert!(m["createdAt"].as_u64().unwrap() > 0);
    }

    #[test] fn b10_backup_round_trips_through_restore() {
        let d = tmp("b10");
        let src = d.join("src");
        fs::create_dir_all(src.join("library")).unwrap();
        tauri::async_runtime::block_on(async {
            let o = SqliteConnectOptions::new().filename(src.join("paper-field.db")).create_if_missing(true);
            let p = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap();
            sqlx::query("CREATE TABLE papers(id INTEGER PRIMARY KEY)").execute(&p).await.unwrap();
            sqlx::query("INSERT INTO papers DEFAULT VALUES").execute(&p).await.unwrap();
            p.close().await;
        });
        fs::write(src.join("library").join("a.pdf"), b"%PDF a").unwrap();
        let zip_path = d.join("b.zip");
        tauri::async_runtime::block_on(backup_at(src.clone(), zip_path.to_string_lossy().into_owned())).unwrap();
        let live = d.join("live");
        fs::create_dir_all(&live).unwrap();
        let s = tauri::async_runtime::block_on(crate::restore::stage_restore(&live, &zip_path)).unwrap();
        assert_eq!((s.papers, s.pdfs), (1, 1));
        tauri::async_runtime::block_on(crate::restore::commit_preview(&live)).unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let status = crate::restore::apply_pending_restore_at(&live, now);
        assert!(matches!(status, crate::restore::RestoreStatus::Restored { .. }), "{status:?}");
        assert_eq!(fs::read(live.join("library").join("a.pdf")).unwrap(), b"%PDF a");
        assert!(!live.join(MANIFEST).exists() && !live.join("library").join(MANIFEST).exists());
    }

    #[test] fn b11_db_copy_includes_rollback_journal() {
        let d = tmp("b11");
        fs::write(d.join("paper-field.db"), b"db").unwrap();
        fs::write(d.join("paper-field.db-journal"), b"journal").unwrap();
        let out = copy_database_aside(&d.join("paper-field.db")).unwrap();
        assert_eq!(fs::read(format!("{out}-journal")).unwrap(), b"journal");
    }

    #[test] fn b4_cleanup_removes_only_snapshots() {
        let d = tmp("b4");
        for n in [".backup-snapshot-1.db", ".backup-snapshot-2.db", "paper-field.db", ".backup-snapshot-x.txt"] { fs::write(d.join(n), "x").unwrap(); }
        cleanup_backup_snapshots(&d);
        assert!(!d.join(".backup-snapshot-1.db").exists() && !d.join(".backup-snapshot-2.db").exists());
        assert!(d.join("paper-field.db").exists() && d.join(".backup-snapshot-x.txt").exists());
    }
}
