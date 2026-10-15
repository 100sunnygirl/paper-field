//! Two-phase library restore.
//!
//! Phase 1 (`restore_library_backup`, app running): unpack the zip into
//! `.restore-staging/`, check the staged database (`integrity_check`,
//! `user_version`), then write the `.restore-in-progress` marker with the full
//! replacement plan. No live file is touched; the frontend then relaunches.
//!
//! Phase 2 (`apply_pending_restore`, startup, before the frontend opens the
//! database): move live files into `pre-restore-<ts>/`, move staged files into
//! place (database last), delete the marker, then delete the staging dir.
//!
//! Marker rule: the marker is written before every step that touches a live
//! file. If the marker cannot be written, no live file is touched and the app
//! starts with `RestoreStatus::Stuck`. The only exception is putting the old
//! database back once the attempt limit is exceeded, which only moves data
//! towards a safer state and is idempotent.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::ZipArchive;

use crate::app_config_dir;
use crate::backup::safe_entry_name;
use crate::secrets::scrub_json_secrets;

pub const SCHEMA_VERSION: i64 = 4; // keep in sync with src/lib/schema.ts:9
const MARKER: &str = ".restore-in-progress";
const STAGING: &str = ".restore-staging";
const DB: &str = "paper-field.db";
const NO_DB: &str = "找不到原来的数据库，恢复标记已保留，请打开原数据目录手动处理";
const SIDECARS: [&str; 2] = ["paper-field.db-wal", "paper-field.db-shm"];
const MAX_ATTEMPTS: u32 = 2;
const STALE_MS: u128 = 10 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Staged but the user has not confirmed yet; startup discards it, never swaps.
    Previewed,
    Staged,
    Swapping,
}

/// One replacement. Paths are relative: `src` to staging, `dest` to the data
/// dir, `backup` to the pre-restore dir (`None` = dest did not exist).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanItem {
    pub src: Option<String>,
    pub dest: String,
    pub backup: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Marker {
    pub stage: Stage,
    pub created_ms: u128,
    pub attempts: u32,
    pub pre: String,
    pub plan: Vec<PlanItem>,
    /// Written at stage time; absent in markers from older versions.
    #[serde(default)]
    pub summary: Option<BackupSummary>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestoreStatus {
    None,
    Restored { pre: String, summary: Option<BackupSummary> },
    RolledBack { pre: String },
    PendingConfirm,
    /// Any stuck state blocks the normal UI, even when a database file exists:
    /// it may be a half-swapped one whose new writes a later rollback would delete.
    Stuck { pre: String, db_available: bool },
}

static STATUS: Mutex<Option<RestoreStatus>> = Mutex::new(None);

/// Serializes every command that reads or writes the marker or pre-restore dirs,
/// so a delete cannot pass its "no marker" check while a restore is being staged.
static OP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn write_marker(dir: &Path, marker: &Marker) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    crate::io_util::atomic_write(&dir.join(MARKER), &json)
}

fn read_marker(dir: &Path) -> Option<Result<Marker, String>> {
    let raw = fs::read(dir.join(MARKER)).ok()?;
    Some(serde_json::from_slice(&raw).map_err(|e| e.to_string()))
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(to);
    }
    fs::rename(from, to).map_err(|e| format!("移动 {} 失败：{e}", from.display()))
}

fn map_entry(name: &str) -> Option<String> {
    if name == DB {
        return Some(DB.into());
    }
    if let Some(file) = name.strip_prefix("library/") {
        if file.contains('/') || !file.to_ascii_lowercase().ends_with(".pdf") {
            return None;
        }
        return Some(format!("library/{file}"));
    }
    match name {
        "settings/llm-settings.json" => Some("llm-settings.json".into()),
        "settings/mineru-settings.json" => Some("mineru-settings.json".into()),
        "settings/biblio-settings.json" => Some("biblio-settings.json".into()),
        _ => None,
    }
}

/// Unpacks `src` into `staging` and returns the relative dest paths written.
fn unpack(src: &Path, staging: &Path) -> Result<Vec<String>, String> {
    let file = File::open(src).map_err(|e| format!("无法打开备份：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("备份不是有效的 zip：{e}"))?;
    let mut written = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else {
            continue;
        };
        if safe_entry_name(&name).is_none() {
            return Err(format!("备份包含不安全路径：{name}"));
        }
        let Some(dest) = map_entry(&name) else { continue };
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if name.starts_with("settings/") {
            bytes = scrub_json_secrets(&String::from_utf8_lossy(&bytes)).into_bytes();
        }
        crate::io_util::atomic_write(&staging.join(&dest), &bytes)?;
        written.push(dest);
    }
    if !written.iter().any(|d| d == DB) {
        return Err("备份里没有 paper-field.db，不是本应用的备份".into());
    }
    Ok(written)
}

/// What a staged backup contains, returned to the UI before the user confirms.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub papers: i64,
    /// Newest `papers.updated_at`; `None` for an empty library or an old schema without it.
    pub latest_updated_at: Option<String>,
    pub pdfs: usize,
    pub zip_bytes: u64,
}

/// `integrity_check` must be `ok` and `user_version` must not be newer than this app.
/// On success returns the paper count and newest `updated_at`, read on the same connection.
pub async fn check_staged_db(db: &Path) -> Result<(i64, Option<String>), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    let options = SqliteConnectOptions::new().filename(db).read_only(true).create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("备份中的数据库无法打开：{e}"))?;
    let result = async {
        let ic: String = sqlx::query("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("备份中的数据库无法读取：{e}"))?
            .get(0);
        if ic != "ok" {
            return Err(format!("备份中的数据库已损坏：{ic}"));
        }
        let version: i64 = sqlx::query("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?
            .get(0);
        if version > SCHEMA_VERSION {
            return Err(format!("备份来自更新版本的应用（数据库版本 {version}），请先升级应用"));
        }
        let papers: i64 = sqlx::query("SELECT count(*) FROM papers")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("备份中的数据库缺少文献表：{e}"))?
            .get(0);
        // Older schemas may lack updated_at; the summary is informational, so treat that as unknown.
        let latest: Option<String> = match sqlx::query("SELECT max(updated_at) FROM papers").fetch_one(&pool).await {
            Ok(row) => row.try_get(0).ok().flatten(),
            Err(_) => None,
        };
        Ok((papers, latest))
    }
    .await;
    pool.close().await;
    result
}

/// Builds the plan: everything except the database first, then the old
/// database sidecars (removed, nothing replaces them), then the database.
fn build_plan(dir: &Path, staged: &[String]) -> Vec<PlanItem> {
    let item = |src: Option<String>, dest: &str| PlanItem {
        src,
        dest: dest.to_string(),
        backup: dir.join(dest).exists().then(|| dest.to_string()),
    };
    let mut plan: Vec<PlanItem> = staged.iter().filter(|d| *d != DB).map(|d| item(Some(d.clone()), d)).collect();
    for sidecar in SIDECARS {
        if dir.join(sidecar).exists() {
            plan.push(item(None, sidecar));
        }
    }
    plan.push(item(Some(DB.into()), DB));
    plan
}

/// Large trees take a while to delete; keep that off the async worker.
async fn remove_dir_off_thread(path: PathBuf) -> std::io::Result<()> {
    tauri::async_runtime::spawn_blocking(move || fs::remove_dir_all(path))
        .await
        .map_err(std::io::Error::other)?
}

pub async fn stage_restore(dir: &Path, src: &Path) -> Result<BackupSummary, String> {
    let _guard = OP_LOCK.lock().await;
    if dir.join(MARKER).exists() {
        return Err("上一次恢复还没处理完，请先重启应用".into());
    }
    let staging = dir.join(STAGING);
    let _ = remove_dir_off_thread(staging.clone()).await;
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = async {
        let staged = unpack(src, &staging)?;
        let (papers, latest_updated_at) = check_staged_db(&staging.join(DB)).await?;
        let summary = BackupSummary {
            papers,
            latest_updated_at,
            pdfs: staged.iter().filter(|d| d.to_ascii_lowercase().ends_with(".pdf")).count(),
            zip_bytes: fs::metadata(src).map(|m| m.len()).unwrap_or(0),
        };
        let marker = Marker {
            stage: Stage::Previewed,
            created_ms: now_ms(),
            attempts: 0,
            pre: format!("pre-restore-{}", now_ms()),
            plan: build_plan(dir, &staged),
            summary: Some(summary.clone()),
        };
        write_marker(dir, &marker)?;
        Ok(summary)
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(dir.join(MARKER));
        let _ = remove_dir_off_thread(staging).await;
    }
    result
}

#[tauri::command]
pub async fn restore_library_backup(app: AppHandle, src: String) -> Result<BackupSummary, String> {
    stage_restore(&app_config_dir(&app)?, Path::new(&src)).await
}

/// Undo by looking at what is actually on disk for each item; safe to repeat.
fn rollback(dir: &Path, marker: &Marker) -> Result<(), String> {
    let pre = dir.join(&marker.pre);
    let staging = dir.join(STAGING);
    for item in marker.plan.iter().rev() {
        let dest = dir.join(&item.dest);
        match &item.backup {
            Some(backup) => {
                let saved = pre.join(backup);
                if saved.exists() {
                    if dest.exists() {
                        fs::remove_file(&dest).map_err(|e| e.to_string())?;
                    }
                    move_file(&saved, &dest)?;
                }
                // not in pre/: the old file was never moved, leave it alone
            }
            None => {
                let still_staged = item.src.as_ref().is_some_and(|s| staging.join(s).exists());
                if !still_staged && dest.exists() {
                    fs::remove_file(&dest).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

fn swap(dir: &Path, marker: &Marker) -> Result<(), String> {
    let pre = dir.join(&marker.pre);
    let staging = dir.join(STAGING);
    for item in &marker.plan {
        let dest = dir.join(&item.dest);
        if let Some(backup) = &item.backup {
            if dest.exists() {
                move_file(&dest, &pre.join(backup))?;
            }
        }
        if let Some(src) = &item.src {
            move_file(&staging.join(src), &dest)?;
        }
    }
    Ok(())
}

fn finish(dir: &Path) {
    // marker first: a crash after this leaves only a harmless staging dir
    let _ = fs::remove_file(dir.join(MARKER));
    let _ = fs::remove_dir_all(dir.join(STAGING));
}

/// Over the attempt limit: make sure a database exists, without writing the marker.
fn give_up(dir: &Path, marker: &Marker) -> RestoreStatus {
    let db_available = ensure_db(dir, Some(&marker.pre));
    RestoreStatus::Stuck { pre: abs(dir, &marker.pre), db_available }
}

/// Old database expected after rollback: the plan moved one aside.
fn expects_db(marker: &Marker) -> bool {
    marker.plan.iter().any(|i| i.dest == DB && i.backup.is_some())
}

fn pre_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<(u128, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ts = name.strip_prefix("pre-restore-")?.parse().ok()?;
            e.path().is_dir().then(|| (ts, e.path()))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    dirs.into_iter().map(|(_, p)| p).collect()
}

/// Only a live database may let the marker go: otherwise `Database.load` would
/// create an empty one. Tries `preferred` first, then the newest pre-restore-*.
fn ensure_db(dir: &Path, preferred: Option<&str>) -> bool {
    let db = dir.join(DB);
    if db.exists() {
        return true;
    }
    let mut candidates: Vec<PathBuf> = preferred.filter(|p| !p.is_empty()).map(|p| dir.join(p)).into_iter().collect();
    candidates.extend(pre_dirs(dir));
    for c in candidates {
        let saved = c.join(DB);
        if !saved.exists() {
            continue;
        }
        // Leftover sidecars belong to some other database: SQLite would replay
        // them into the one we bring back, so move them aside first.
        if !quarantine_sidecars(dir) || move_file(&saved, &db).is_err() {
            return false;
        }
        // db first: a crash here leaves an older-but-consistent db, never an empty one
        for sidecar in SIDECARS {
            let s = c.join(sidecar);
            if s.exists() && move_file(&s, &dir.join(sidecar)).is_err() {
                return false;
            }
        }
        return true;
    }
    false
}

fn quarantine_sidecars(dir: &Path) -> bool {
    let left: Vec<&str> = SIDECARS.iter().copied().filter(|s| dir.join(s).exists()).collect();
    if left.is_empty() {
        return true;
    }
    let q = dir.join(format!(".restore-orphans-{}", now_ms()));
    fs::create_dir_all(&q).is_ok() && left.iter().all(|s| move_file(&dir.join(s), &q.join(s)).is_ok())
}

fn abs(dir: &Path, pre: &str) -> String {
    if pre.is_empty() { String::new() } else { dir.join(pre).display().to_string() }
}

pub fn apply_pending_restore_at(dir: &Path, now: u128) -> RestoreStatus {
    let mut marker = match read_marker(dir) {
        None => return RestoreStatus::None,
        Some(Ok(marker)) => marker,
        Some(Err(_)) => {
            return RestoreStatus::Stuck { pre: String::new(), db_available: dir.join(DB).exists() };
        }
    };
    if marker.stage == Stage::Previewed {
        // The app quit or crashed while the confirm dialog was open: nothing was
        // moved yet, so dropping the marker and staging is a complete undo.
        finish(dir);
        return RestoreStatus::None;
    }
    if marker.stage == Stage::Staged && now.saturating_sub(marker.created_ms) > STALE_MS {
        return RestoreStatus::PendingConfirm;
    }
    marker.attempts += 1;
    if marker.attempts > MAX_ATTEMPTS {
        return give_up(dir, &marker);
    }
    let stuck = |m: &Marker| RestoreStatus::Stuck { pre: abs(dir, &m.pre), db_available: dir.join(DB).exists() };
    if marker.stage == Stage::Staged {
        if fs::create_dir(dir.join(&marker.pre)).is_err() {
            return stuck(&marker);
        }
        marker.stage = Stage::Swapping;
        if write_marker(dir, &marker).is_err() {
            let _ = fs::remove_dir(dir.join(&marker.pre));
            return stuck(&marker);
        }
        if swap(dir, &marker).is_ok() {
            finish(dir);
            return RestoreStatus::Restored { pre: abs(dir, &marker.pre), summary: marker.summary.clone() };
        }
    } else if write_marker(dir, &marker).is_err() {
        return stuck(&marker);
    }
    match rollback(dir, &marker) {
        Ok(()) if expects_db(&marker) && !ensure_db(dir, Some(&marker.pre)) => stuck(&marker),
        Ok(()) => {
            finish(dir);
            RestoreStatus::RolledBack { pre: abs(dir, &marker.pre) }
        }
        Err(_) => stuck(&marker),
    }
}

pub fn apply_pending_restore(dir: &Path) {
    let status = apply_pending_restore_at(dir, now_ms());
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(status);
}

#[tauri::command]
pub fn restore_status() -> RestoreStatus {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or(RestoreStatus::None)
}

/// User confirmed a stale staged restore: refresh its timestamp; applied on next launch.
#[tauri::command]
pub fn restore_confirm_pending(app: AppHandle) -> Result<(), String> {
    let dir = app_config_dir(&app)?;
    let Some(Ok(mut marker)) = read_marker(&dir) else { return Err("没有待确认的恢复".into()) };
    if marker.stage != Stage::Staged {
        return Err("没有待确认的恢复".into());
    }
    marker.created_ms = now_ms();
    write_marker(&dir, &marker)
}

/// The user confirmed the preview: from now on the next launch swaps it in.
pub async fn commit_preview(dir: &Path) -> Result<(), String> {
    let _guard = OP_LOCK.lock().await;
    let Some(Ok(mut marker)) = read_marker(dir) else { return Err("没有待确认的恢复".into()) };
    if marker.stage != Stage::Previewed {
        return Err("没有待确认的恢复".into());
    }
    marker.stage = Stage::Staged;
    marker.created_ms = now_ms();
    write_marker(dir, &marker)
}

#[tauri::command]
pub async fn restore_commit_preview(app: AppHandle) -> Result<(), String> {
    commit_preview(&app_config_dir(&app)?).await
}

/// One `pre-restore-<ms>` copy of the library taken before a restore.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreDir {
    pub name: String,
    pub path: String,
    pub created_ms: u128,
    pub bytes: u64,
    pub has_db: bool,
}

const PRE_BUSY: &str = "恢复还没处理完，暂不能清理原数据副本";

/// `pre-restore-<digits>` exactly; returns the timestamp.
fn pre_name_ms(name: &str) -> Option<u128> {
    let digits = name.strip_prefix("pre-restore-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Size without following symlinks.
fn tree_bytes(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| tree_bytes(&e.path())).sum())
        .unwrap_or(0)
}

pub fn list_pre(dir: &Path) -> (Vec<PreDir>, bool) {
    let busy = dir.join(MARKER).exists();
    let mut out: Vec<PreDir> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let created_ms = pre_name_ms(&name)?;
                    let meta = fs::symlink_metadata(e.path()).ok()?;
                    meta.is_dir().then(|| PreDir {
                        path: abs(dir, &name),
                        bytes: tree_bytes(&e.path()),
                        has_db: e.path().join(DB).is_file(),
                        name,
                        created_ms,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    (out, busy)
}

pub async fn delete_pre(dir: &Path, name: &str) -> Result<(), String> {
    let _guard = OP_LOCK.lock().await;
    if pre_name_ms(name).is_none() {
        return Err("不是原数据副本目录".into());
    }
    // Any marker (even unreadable) means some pre dir may still be a rollback source.
    if dir.join(MARKER).exists() {
        return Err(PRE_BUSY.into());
    }
    let target = dir.join(name);
    let meta = fs::symlink_metadata(&target).map_err(|_| "目录不存在".to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("不是原数据副本目录".into());
    }
    remove_dir_off_thread(target).await.map_err(|e| format!("删除失败：{e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreList {
    pub dirs: Vec<PreDir>,
    pub busy: bool,
}

#[tauri::command]
pub async fn restore_list_pre(app: AppHandle) -> Result<PreList, String> {
    list_pre_off_thread(app_config_dir(&app)?).await
}

/// `tree_bytes` walks every file of every copy: keep it off the calling thread.
async fn list_pre_off_thread(dir: PathBuf) -> Result<PreList, String> {
    let (dirs, busy) = tauri::async_runtime::spawn_blocking(move || list_pre(&dir))
        .await
        .map_err(|e| e.to_string())?;
    Ok(PreList { dirs, busy })
}

#[tauri::command]
pub async fn restore_delete_pre(app: AppHandle, name: String) -> Result<(), String> {
    delete_pre(&app_config_dir(&app)?, &name).await
}

/// User gives up on the pending restore, whatever state it is in (staged,
/// pending confirmation, stuck, or an unreadable marker). Puts old files back
/// where they were moved, clears the marker, and allows a fresh restore.
pub async fn abandon_restore(dir: &Path) -> Result<(), String> {
    let _guard = OP_LOCK.lock().await;
    // Rollback moves files and finish() deletes the staging tree: keep both off
    // the async worker, with the lock held for the whole undo.
    let dir = dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || abandon_locked(&dir))
        .await
        .map_err(|e| e.to_string())?
}

fn abandon_locked(dir: &Path) -> Result<(), String> {
    match read_marker(dir) {
        None => {}
        Some(Ok(marker)) => {
            rollback(dir, &marker)?;
            if expects_db(&marker) && !ensure_db(dir, Some(&marker.pre)) {
                return Err(NO_DB.into());
            }
        }
        // Unreadable marker: no plan. Bring back the newest moved-aside database
        // if the live one is gone; with no pre-restore-* dir nothing was moved.
        Some(Err(_)) => {
            if !ensure_db(dir, None) && !pre_dirs(dir).is_empty() {
                return Err(NO_DB.into());
            }
        }
    }
    finish(dir);
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(RestoreStatus::None);
    Ok(())
}

#[tauri::command]
pub async fn restore_abandon(app: AppHandle) -> Result<(), String> {
    abandon_restore(&app_config_dir(&app)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::io::Write;

    fn tmp(n: &str) -> PathBuf {
        let d = crate::test_util::unique_temp_dir(&format!("pf-restore-{n}"));
        fs::create_dir_all(d.join("library")).unwrap();
        d
    }

    fn make_db(path: &Path, version: i64, rows: i64) {
        tauri::async_runtime::block_on(async {
            let o = SqliteConnectOptions::new().filename(path).create_if_missing(true);
            let p = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap();
            sqlx::query("CREATE TABLE papers(id INTEGER PRIMARY KEY)").execute(&p).await.unwrap();
            for _ in 0..rows {
                sqlx::query("INSERT INTO papers DEFAULT VALUES").execute(&p).await.unwrap();
            }
            sqlx::query(&format!("PRAGMA user_version = {version}")).execute(&p).await.unwrap();
            p.close().await;
        });
    }

    fn rows(path: &Path) -> i64 {
        tauri::async_runtime::block_on(async {
            use sqlx::Row;
            let o = SqliteConnectOptions::new().filename(path).read_only(true);
            let p = SqlitePoolOptions::new().connect_with(o).await.unwrap();
            let n: i64 = sqlx::query("SELECT count(*) FROM papers").fetch_one(&p).await.unwrap().get(0);
            p.close().await;
            n
        })
    }

    /// Live dir: db with 1 row, old.pdf, shared.pdf="old". Backup: db with 7 rows, new.pdf, shared.pdf="new".
    fn setup(n: &str) -> (PathBuf, PathBuf) {
        let d = tmp(n);
        let live = d.join("live");
        fs::create_dir_all(live.join("library")).unwrap();
        make_db(&live.join(DB), 4, 1);
        fs::write(live.join("library/old.pdf"), "old-only").unwrap();
        fs::write(live.join("library/shared.pdf"), "old").unwrap();
        let src_db = d.join("src.db");
        make_db(&src_db, 4, 7);
        let zip_path = d.join("backup.zip");
        let mut z = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file(DB, o).unwrap();
        z.write_all(&fs::read(&src_db).unwrap()).unwrap();
        for (name, body) in [("library/new.pdf", "new-only"), ("library/shared.pdf", "new")] {
            z.start_file(name, o).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
        (live, zip_path)
    }

    fn stage(live: &Path, zip: &Path) -> Result<(), String> {
        stage_summary(live, zip)?;
        tauri::async_runtime::block_on(commit_preview(live))
    }

    fn stage_summary(live: &Path, zip: &Path) -> Result<BackupSummary, String> {
        tauri::async_runtime::block_on(stage_restore(live, zip))
    }

    fn assert_original(live: &Path) {
        assert_eq!(rows(&live.join(DB)), 1);
        assert_eq!(fs::read_to_string(live.join("library/shared.pdf")).unwrap(), "old");
        assert!(live.join("library/old.pdf").exists());
        assert!(!live.join("library/new.pdf").exists(), "new file must be removed on rollback");
    }

    #[test]
    fn staging_does_not_touch_live_files() {
        let (live, zip) = setup("stage");
        stage(&live, &zip).unwrap();
        assert_original(&live);
        assert!(live.join(MARKER).exists());
    }

    #[test]
    fn startup_swaps_in_backup() {
        let (live, zip) = setup("swap");
        stage(&live, &zip).unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        assert_eq!(rows(&live.join(DB)), 7);
        assert_eq!(fs::read_to_string(live.join("library/shared.pdf")).unwrap(), "new");
        assert!(live.join("library/new.pdf").exists());
        assert!(!live.join(MARKER).exists() && !live.join(STAGING).exists());
    }

    #[test]
    fn rejects_corrupt_and_newer_backups_before_marker() {
        let (live, zip) = setup("bad");
        // truncated database: header intact, body cut
        let staging_zip = live.parent().unwrap().join("trunc.zip");
        let full = fs::read(live.parent().unwrap().join("src.db")).unwrap();
        let mut z = zip::ZipWriter::new(File::create(&staging_zip).unwrap());
        z.start_file(DB, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(&full[..full.len() / 2]).unwrap();
        z.finish().unwrap();
        assert!(stage(&live, &staging_zip).is_err());
        assert!(!live.join(MARKER).exists());
        make_db(&live.parent().unwrap().join("v9.db"), 9, 1);
        let _ = zip;
        let v9 = live.parent().unwrap().join("v9.zip");
        let mut z = zip::ZipWriter::new(File::create(&v9).unwrap());
        z.start_file(DB, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(&fs::read(live.parent().unwrap().join("v9.db")).unwrap()).unwrap();
        z.finish().unwrap();
        assert!(stage(&live, &v9).unwrap_err().contains("更新版本"));
        assert_original(&live);
    }

    /// Simulate a crash after `k` filesystem steps of the swap, for every k.
    #[test]
    fn crash_at_every_swap_step_rolls_back() {
        for k in 0..12 {
            let (live, zip) = setup(&format!("crash{k}"));
            stage(&live, &zip).unwrap();
            let mut m = read_marker(&live).unwrap().unwrap();
            fs::create_dir(live.join(&m.pre)).unwrap();
            m.stage = Stage::Swapping;
            m.attempts = 1;
            write_marker(&live, &m).unwrap();
            let (pre, staging) = (live.join(&m.pre), live.join(STAGING));
            let mut steps = 0;
            'outer: for item in &m.plan {
                if let Some(b) = &item.backup {
                    if steps == k { break 'outer; }
                    move_file(&live.join(&item.dest), &pre.join(b)).unwrap();
                    steps += 1;
                }
                if let Some(s) = &item.src {
                    if steps == k { break 'outer; }
                    move_file(&staging.join(s), &live.join(&item.dest)).unwrap();
                    steps += 1;
                }
            }
            let status = apply_pending_restore_at(&live, now_ms());
            assert!(matches!(status, RestoreStatus::RolledBack { .. }), "k={k}: {status:?}");
            assert_original(&live);
            assert!(!live.join(MARKER).exists());
            // rollback is idempotent
            assert_eq!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::None);
        }
    }

    #[test]
    fn stale_staged_marker_needs_confirmation() {
        let (live, zip) = setup("stale");
        stage(&live, &zip).unwrap();
        let later = now_ms() + STALE_MS + 1;
        assert_eq!(apply_pending_restore_at(&live, later), RestoreStatus::PendingConfirm);
        assert_original(&live);
    }

    #[test]
    fn over_limit_without_db_puts_old_db_back_never_empty() {
        let (live, zip) = setup("limit");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        fs::create_dir(live.join(&m.pre)).unwrap();
        move_file(&live.join(DB), &live.join(&m.pre).join(DB)).unwrap();
        m.stage = Stage::Swapping;
        m.attempts = MAX_ATTEMPTS;
        write_marker(&live, &m).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { db_available: true, .. }), "{status:?}");
        assert_eq!(rows(&live.join(DB)), 1);
    }

    #[test]
    fn over_limit_with_no_db_anywhere_reports_unavailable() {
        let (live, zip) = setup("nodb");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        fs::remove_file(live.join(DB)).unwrap();
        m.stage = Stage::Swapping;
        m.attempts = MAX_ATTEMPTS;
        write_marker(&live, &m).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { db_available: false, .. }), "{status:?}");
        assert!(!live.join(DB).exists(), "must not create an empty database");
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_marker_touches_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let (live, zip) = setup("ro");
        stage(&live, &zip).unwrap();
        let before = fs::read(live.join(DB)).unwrap();
        fs::set_permissions(&live, fs::Permissions::from_mode(0o555)).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        fs::set_permissions(&live, fs::Permissions::from_mode(0o755)).unwrap();
        if nix_is_root() { return; } // root ignores permissions; nothing to assert
        assert!(matches!(status, RestoreStatus::Stuck { .. }), "{status:?}");
        assert_eq!(fs::read(live.join(DB)).unwrap(), before);
        assert_original(&live);
    }

    #[cfg(unix)]
    fn nix_is_root() -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    #[test]
    fn schema_version_matches_frontend() {
        let ts = include_str!("../../src/lib/schema.ts");
        let line = ts.lines().find(|l| l.contains("export const SCHEMA_VERSION")).expect("SCHEMA_VERSION in schema.ts");
        let n: i64 = line.split('=').nth(1).unwrap().trim().trim_end_matches(';').parse().unwrap();
        assert_eq!(n, SCHEMA_VERSION);
    }

    #[test]
    fn stuck_while_swapping_is_stuck_even_with_db() {
        let (live, zip) = setup("swapstuck");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        m.stage = Stage::Swapping;
        m.attempts = MAX_ATTEMPTS;
        write_marker(&live, &m).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { db_available: true, .. }), "{status:?}");
    }

    #[test]
    fn abandon_from_stuck_restores_old_files_and_allows_new_restore() {
        let (live, zip) = setup("abandon");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        fs::create_dir(live.join(&m.pre)).unwrap();
        // half swapped: shared.pdf replaced, db moved aside but new one not in yet
        move_file(&live.join("library/shared.pdf"), &live.join(&m.pre).join("library/shared.pdf")).unwrap();
        move_file(&live.join(STAGING).join("library/shared.pdf"), &live.join("library/shared.pdf")).unwrap();
        move_file(&live.join(DB), &live.join(&m.pre).join(DB)).unwrap();
        m.stage = Stage::Swapping;
        m.attempts = MAX_ATTEMPTS + 1;
        write_marker(&live, &m).unwrap();
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
        assert!(!live.join(MARKER).exists());
        stage(&live, &zip).expect("a new restore can be started");
    }

    #[test]
    fn abandon_from_pending_confirm_touches_nothing() {
        let (live, zip) = setup("abandon-pending");
        stage(&live, &zip).unwrap();
        assert_eq!(apply_pending_restore_at(&live, now_ms() + STALE_MS + 1), RestoreStatus::PendingConfirm);
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
        assert!(!live.join(MARKER).exists() && !live.join(STAGING).exists());
        stage(&live, &zip).unwrap();
    }

    #[test]
    fn corrupt_marker_is_stuck_and_can_be_cleared() {
        let (live, zip) = setup("corrupt");
        fs::write(live.join(MARKER), b"{not json").unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Stuck { .. }));
        assert!(stage(&live, &zip).is_err());
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
        stage(&live, &zip).unwrap();
    }
    #[test]
    fn tester_e2e_stuck_without_any_db_never_creates_empty_db() {
        let (live, zip) = setup("tester-nodb");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        m.stage = Stage::Swapping;
        write_marker(&live, &m).unwrap();
        // simulate: old db already moved away and lost, new db not yet in place
        let db = live.join("paper-field.db");
        let _ = fs::remove_file(&db);
        for e in fs::read_dir(&live).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() && p.file_name().unwrap().to_string_lossy().starts_with("pre-restore-") {
                let _ = fs::remove_file(p.join("paper-field.db"));
            }
        }
        let _ = fs::remove_file(live.join(".restore-staging").join("paper-field.db"));
        for boot in 1..=5 {
            let st = apply_pending_restore_at(&live, now_ms());
            eprintln!("boot {boot}: {st:?}");
            assert!(matches!(st, RestoreStatus::Stuck { db_available: false, .. }) || boot == 1 && matches!(st, RestoreStatus::Stuck { .. }), "boot {boot}: {st:?}");
            assert!(!db.exists(), "BUG boot {boot}: empty db created at {}", db.display());
        }
        assert!(read_marker(&live).is_some(), "marker must stay so the UI keeps blocking");
    }

    fn lose_old_db(live: &Path) {
        let _ = fs::remove_file(live.join(DB));
        for p in pre_dirs(live) {
            let _ = fs::remove_file(p.join(DB));
        }
        let _ = fs::remove_file(live.join(STAGING).join(DB));
    }

    #[test]
    fn abandon_without_any_db_keeps_marker() {
        let (live, zip) = setup("abandon-nodb");
        stage(&live, &zip).unwrap();
        let mut m = read_marker(&live).unwrap().unwrap();
        m.stage = Stage::Swapping;
        write_marker(&live, &m).unwrap();
        fs::create_dir(live.join(&m.pre)).unwrap();
        lose_old_db(&live);
        assert!(tauri::async_runtime::block_on(abandon_restore(&live)).is_err());
        assert!(read_marker(&live).is_some() && !live.join(DB).exists());
    }

    #[test]
    fn corrupt_marker_brings_back_newest_pre_db() {
        let (live, _zip) = setup("corrupt-pre");
        let old = live.join("pre-restore-100");
        let new = live.join("pre-restore-200");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        fs::copy(live.join(DB), old.join(DB)).unwrap();
        fs::rename(live.join(DB), new.join(DB)).unwrap();
        fs::write(live.join(MARKER), b"{not json").unwrap();
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert!(live.join(DB).exists() && !new.join(DB).exists() && old.join(DB).exists());
        assert!(read_marker(&live).is_none());
    }

    #[test]
    fn corrupt_marker_with_pre_dir_but_no_db_stays_stuck() {
        let (live, _zip) = setup("corrupt-nodb");
        fs::create_dir(live.join("pre-restore-300")).unwrap();
        fs::remove_file(live.join(DB)).unwrap();
        fs::write(live.join(MARKER), b"{not json").unwrap();
        assert!(tauri::async_runtime::block_on(abandon_restore(&live)).is_err());
        assert!(live.join(MARKER).exists() && !live.join(DB).exists());
    }

    #[test]
    fn ensure_db_moves_db_with_its_wal_and_quarantines_leftovers() {
        let (live, _zip) = setup("ensure-wal");
        let pre = live.join("pre-restore-400");
        fs::create_dir(&pre).unwrap();
        fs::rename(live.join(DB), pre.join(DB)).unwrap();
        fs::write(pre.join("paper-field.db-wal"), b"old-wal").unwrap();
        fs::write(live.join("paper-field.db-wal"), b"stray-wal").unwrap();
        fs::write(live.join("paper-field.db-shm"), b"stray-shm").unwrap();
        assert!(ensure_db(&live, None));
        assert!(live.join(DB).exists() && !pre.join(DB).exists());
        assert_eq!(fs::read(live.join("paper-field.db-wal")).unwrap(), b"old-wal");
        assert!(!live.join("paper-field.db-shm").exists());
        let q: Vec<_> = fs::read_dir(&live).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".restore-orphans-")).collect();
        assert_eq!(q.len(), 1);
        assert_eq!(fs::read(q[0].path().join("paper-field.db-wal")).unwrap(), b"stray-wal");
        assert!(q[0].path().join("paper-field.db-shm").exists());
    }

    #[test]
    fn summary_counts_papers_and_pdfs() {
        let (live, zip) = setup("summary");
        let s = stage_summary(&live, &zip).unwrap();
        assert_eq!(s.papers, 7);
        assert_eq!(s.pdfs, 2);
        assert_eq!(s.zip_bytes, fs::metadata(&zip).unwrap().len());
        assert_eq!(s.latest_updated_at, None, "test schema has no updated_at");
        assert_original(&live);
    }

    #[test]
    fn summary_reads_latest_updated_at() {
        let d = tmp("summary-ts");
        let live = d.join("live");
        fs::create_dir_all(&live).unwrap();
        let db = d.join("src.db");
        tauri::async_runtime::block_on(async {
            let o = SqliteConnectOptions::new().filename(&db).create_if_missing(true);
            let p = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap();
            sqlx::query("CREATE TABLE papers(id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL)").execute(&p).await.unwrap();
            for t in ["2026-01-02T00:00:00Z", "2026-10-13T09:00:00Z", "2025-05-05T00:00:00Z"] {
                sqlx::query("INSERT INTO papers(updated_at) VALUES (?)").bind(t).execute(&p).await.unwrap();
            }
            sqlx::query("PRAGMA user_version = 4").execute(&p).await.unwrap();
            p.close().await;
        });
        let zip_path = d.join("b.zip");
        let mut z = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        z.start_file(DB, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(&fs::read(&db).unwrap()).unwrap();
        z.finish().unwrap();
        let s = stage_summary(&live, &zip_path).unwrap();
        assert_eq!(s.papers, 3);
        assert_eq!(s.pdfs, 0);
        assert_eq!(s.latest_updated_at.as_deref(), Some("2026-10-13T09:00:00Z"));
    }

    #[test]
    fn summary_of_empty_library_is_zero() {
        let d = tmp("summary-empty");
        let live = d.join("live");
        fs::create_dir_all(&live).unwrap();
        let db = d.join("src.db");
        make_db(&db, 4, 0);
        let zip_path = d.join("b.zip");
        let mut z = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        z.start_file(DB, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(&fs::read(&db).unwrap()).unwrap();
        z.finish().unwrap();
        let s = stage_summary(&live, &zip_path).unwrap();
        assert_eq!((s.papers, s.pdfs, s.latest_updated_at), (0, 0, None));
        assert!(live.join(MARKER).exists());
    }

    #[test]
    fn abandon_after_preview_cancel_leaves_everything_as_before() {
        let (live, zip) = setup("preview-cancel");
        stage(&live, &zip).unwrap();
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
        assert!(!live.join(MARKER).exists());
        assert!(!live.join(STAGING).exists());
        assert!(pre_dirs(&live).is_empty(), "cancel must not create pre-restore dirs");
        stage(&live, &zip).expect("a new restore is allowed after cancel");
    }

    #[test]
    fn unconfirmed_preview_is_discarded_on_next_launch() {
        let (live, zip) = setup("preview-crash");
        stage_summary(&live, &zip).unwrap();
        assert_eq!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::None);
        assert_original(&live);
        assert!(!live.join(MARKER).exists());
        assert!(!live.join(STAGING).exists());
        assert!(pre_dirs(&live).is_empty());
    }

    #[test]
    fn commit_preview_only_accepts_previewed() {
        let (live, zip) = setup("preview-commit");
        assert!(tauri::async_runtime::block_on(commit_preview(&live)).is_err(), "no marker");
        stage(&live, &zip).unwrap();
        assert!(tauri::async_runtime::block_on(commit_preview(&live)).is_err(), "already staged");
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
    }

    #[test]
    fn restored_status_carries_summary_and_pre() {
        let (live, zip) = setup("p3-restored");
        stage(&live, &zip).unwrap();
        match apply_pending_restore_at(&live, now_ms()) {
            RestoreStatus::Restored { pre, summary } => {
                assert!(pre.contains("pre-restore-"));
                let s = summary.expect("summary written at stage time");
                assert_eq!((s.papers, s.pdfs), (7, 2));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn old_marker_without_summary_still_parses() {
        let json = r#"{"stage":"staged","created_ms":1,"attempts":0,"pre":"pre-restore-1","plan":[]}"#;
        let m: Marker = serde_json::from_str(json).unwrap();
        assert!(m.summary.is_none());
    }

    fn restored_live(n: &str) -> PathBuf {
        let (live, zip) = setup(n);
        stage(&live, &zip).unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        live
    }

    #[test]
    fn list_and_delete_pre_dirs() {
        let live = restored_live("p3-list");
        fs::create_dir(live.join("pre-restore-5")).unwrap();
        let (dirs, busy) = list_pre(&live);
        assert!(!busy);
        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].has_db && dirs[0].bytes > 0, "newest first, holds the old db");
        assert_eq!(dirs[1].name, "pre-restore-5");
        tauri::async_runtime::block_on(delete_pre(&live, "pre-restore-5")).unwrap();
        assert!(!live.join("pre-restore-5").exists());
        assert!(live.join(&dirs[0].name).exists(), "other dirs untouched");
    }

    #[test]
    fn delete_pre_refused_while_any_marker_exists() {
        let live = restored_live("p3-busy");
        let name = list_pre(&live).0[0].name.clone();
        fs::write(live.join(MARKER), "not json").unwrap();
        assert!(list_pre(&live).1);
        assert_eq!(tauri::async_runtime::block_on(delete_pre(&live, &name)), Err(PRE_BUSY.into()));
        assert!(live.join(&name).exists());
    }

    #[test]
    fn delete_pre_rejects_bad_names_and_symlinks() {
        let live = restored_live("p3-names");
        for bad in ["../x", "pre-restore-1/..", "library", "pre-restore-", "pre-restore-1a", DB] {
            assert!(tauri::async_runtime::block_on(delete_pre(&live, bad)).is_err(), "{bad}");
        }
        assert!(live.join("library").exists() && live.join(DB).exists());
        #[cfg(unix)]
        {
            let outside = live.parent().unwrap().join("outside");
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("keep"), "x").unwrap();
            std::os::unix::fs::symlink(&outside, live.join("pre-restore-9")).unwrap();
            assert!(tauri::async_runtime::block_on(delete_pre(&live, "pre-restore-9")).is_err());
            assert!(outside.join("keep").exists());
        }
    }

    #[test]
    fn delete_waits_for_lock_then_rechecks_marker() {
        let live = restored_live("p3-lock");
        let name = list_pre(&live).0[0].name.clone();
        let guard = OP_LOCK.blocking_lock();
        let (l2, n2) = (live.clone(), name.clone());
        let handle = std::thread::spawn(move || tauri::async_runtime::block_on(delete_pre(&l2, &n2)));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!handle.is_finished(), "delete must wait for the lock");
        // A restore staged while the delete was waiting.
        fs::write(live.join(MARKER), "{}").unwrap();
        drop(guard);
        assert_eq!(handle.join().unwrap(), Err(PRE_BUSY.into()));
        assert!(live.join(&name).exists());
    }

    #[test]
    fn delete_does_not_block_its_thread_while_restore_holds_lock() {
        let live = restored_live("p7-nonblock");
        let name = list_pre(&live).0[0].name.clone();
        let guard = OP_LOCK.blocking_lock();
        let started = std::time::Instant::now();
        // Old sync version parked the calling (main) thread here until the lock freed.
        let waited = tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(100), delete_pre(&live, &name)).await
        });
        assert!(waited.is_err(), "must still be waiting for the lock");
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        drop(guard);
        tauri::async_runtime::block_on(delete_pre(&live, &name)).unwrap();
        assert!(!live.join(&name).exists());
    }

    fn assert_waits_for_lock<F: FnOnce() + Send + 'static>(f: F) {
        let guard = OP_LOCK.blocking_lock();
        let handle = std::thread::spawn(f);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!handle.is_finished(), "must wait for the restore lock");
        drop(guard);
        handle.join().unwrap();
    }

    #[test]
    fn abandon_does_not_block_its_thread_while_restore_holds_lock() {
        let (live, zip) = setup("p8-abandon-nonblock");
        stage(&live, &zip).unwrap();
        let guard = OP_LOCK.blocking_lock();
        let waited = tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(100), abandon_restore(&live)).await
        });
        assert!(waited.is_err(), "must still be waiting for the lock");
        assert!(live.join(MARKER).exists(), "nothing undone while waiting");
        drop(guard);
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert!(!live.join(MARKER).exists());
    }

    #[test]
    fn abandon_and_commit_wait_for_lock() {
        let (live, _) = setup("p3-lock-ops");
        let l = live.clone();
        assert_waits_for_lock(move || { let _ = tauri::async_runtime::block_on(abandon_restore(&l)); });
        assert_waits_for_lock(move || { let _ = tauri::async_runtime::block_on(commit_preview(&live)); });
    }

    #[test]
    fn commit_preview_does_not_block_its_thread_while_restore_holds_lock() {
        let (live, zip) = setup("p9-commit-nonblock");
        stage_summary(&live, &zip).unwrap();
        let guard = OP_LOCK.blocking_lock();
        let waited = tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(100), commit_preview(&live)).await
        });
        assert!(waited.is_err(), "must still be waiting for the lock");
        drop(guard);
        tauri::async_runtime::block_on(commit_preview(&live)).unwrap();
        // Now staged: a second commit is refused.
        assert!(tauri::async_runtime::block_on(commit_preview(&live)).is_err());
    }

    #[test]
    fn list_pre_runs_off_the_calling_thread() {
        let live = restored_live("p9-list-offthread");
        let caller = std::thread::current().id();
        let mut fut = Box::pin(list_pre_off_thread(live.clone()));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        // A sync walk inside the future would finish on this first poll, on this thread.
        assert!(std::future::Future::poll(fut.as_mut(), &mut cx).is_pending(), "size walk must not run on the caller");
        let list = tauri::async_runtime::block_on(fut).unwrap();
        assert_eq!(std::thread::current().id(), caller);
        assert_eq!(list.dirs, list_pre(&live).0);
        assert!(!list.busy);
    }
}
