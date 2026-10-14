//! Zip backup of the database, the library PDFs, and non-secret settings.
//! Restore copies the current database aside before replacing anything.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::app_config_dir;
use crate::secrets::scrub_json_secrets;

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
    for suffix in ["-wal", "-shm"] {
        let extra = PathBuf::from(format!("{}{suffix}", src.display()));
        if extra.exists() {
            let dest_extra = PathBuf::from(format!("{}{suffix}", dest.display()));
            fs::copy(&extra, &dest_extra).map_err(|err| format!("复制数据库日志失败：{err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn backup_database_file(app: AppHandle) -> Result<String, String> {
    let src = database_file(&app)?;
    if !src.exists() {
        return Ok(String::new());
    }
    let dest = src.with_file_name(format!("paper-field.db.premigrate-{}", stamp()));
    copy_sqlite_family(&src, &dest)?;
    Ok(dest.display().to_string())
}

fn add_file(zip: &mut ZipWriter<File>, options: SimpleFileOptions, name: &str, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|err| err.to_string())?;
    zip.start_file(name, options).map_err(|err| err.to_string())?;
    zip.write_all(&bytes).map_err(|err| err.to_string())?;
    Ok(())
}

fn add_scrubbed_settings(zip: &mut ZipWriter<File>, options: SimpleFileOptions, name: &str, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let scrubbed = scrub_json_secrets(&raw);
    zip.start_file(name, options).map_err(|err| err.to_string())?;
    zip.write_all(scrubbed.as_bytes()).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_library_backup(app: AppHandle, dest: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let db = dir.join("paper-field.db");
    let snap = dir.join(format!(".backup-snapshot-{}.db", stamp()));
    if db.exists() {
        snapshot_database(&db, &snap).await?;
    }
    let result = write_backup_zip(&dir, &snap, &dest);
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

fn write_backup_zip(dir: &Path, snap: &Path, dest: &str) -> Result<(), String> {
    let file = File::create(dest).map_err(|err| format!("无法创建备份：{err}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    add_file(&mut zip, options, "paper-field.db", snap)?;
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
            add_file(&mut zip, options, &format!("library/{name}"), &path)?;
        }
    }
    add_scrubbed_settings(&mut zip, options, "settings/llm-settings.json", &dir.join("llm-settings.json"))?;
    add_scrubbed_settings(&mut zip, options, "settings/mineru-settings.json", &dir.join("mineru-settings.json"))?;
    add_file(&mut zip, options, "settings/biblio-settings.json", &dir.join("biblio-settings.json"))?;
    zip.finish().map_err(|err| format!("完成备份失败：{err}"))?;
    Ok(())
}

fn safe_entry_name(name: &str) -> Option<&str> {
    if name.is_empty() || name.starts_with('/') || name.starts_with('\\') || name.contains("..") {
        return None;
    }
    let normalized = name.replace('\\', "/");
    if normalized.split('/').any(|part| part == ".." || part.is_empty() && normalized.contains("//")) {
        return None;
    }
    Some(name)
}

#[tauri::command]
pub fn restore_library_backup(app: AppHandle, src: String) -> Result<String, String> {
    let dir = config_dir(&app)?;
    let db = dir.join("paper-field.db");
    let mut pre = String::new();
    if db.exists() {
        let dest = db.with_file_name(format!("paper-field.db.pre-restore-{}", stamp()));
        copy_sqlite_family(&db, &dest)?;
        pre = dest.display().to_string();
    }
    let file = File::open(&src).map_err(|err| format!("无法打开备份：{err}"))?;
    let mut archive = ZipArchive::new(file).map_err(|err| format!("备份不是有效的 zip：{err}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let Some(name) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let name_str = name.to_string_lossy().replace('\\', "/");
        if safe_entry_name(&name_str).is_none() {
            return Err(format!("备份包含不安全路径：{name_str}"));
        }
        let dest = if name_str == "paper-field.db" {
            db.clone()
        } else if let Some(file_name) = name_str.strip_prefix("library/") {
            if file_name.contains('/') || !file_name.to_ascii_lowercase().ends_with(".pdf") {
                continue;
            }
            dir.join("library").join(file_name)
        } else if name_str == "settings/llm-settings.json" {
            dir.join("llm-settings.json")
        } else if name_str == "settings/mineru-settings.json" {
            dir.join("mineru-settings.json")
        } else if name_str == "settings/biblio-settings.json" {
            dir.join("biblio-settings.json")
        } else {
            continue;
        };
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|err| err.to_string())?;
        if name_str.starts_with("settings/") {
            let scrubbed = scrub_json_secrets(&String::from_utf8_lossy(&bytes));
            crate::io_util::atomic_write(&dest, scrubbed.as_bytes())?;
        } else {
            let mut out = File::create(&dest).map_err(|err| err.to_string())?;
            out.write_all(&bytes).map_err(|err| err.to_string())?;
        }
    }
    Ok(pre)
}
