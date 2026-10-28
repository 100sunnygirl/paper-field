//! Two-phase library restore.
//!
//! Phase 1 (`restore_library_backup`, app running): unpack the zip into
//! `.restore-staging/` (checked against `manifest.json` when present), check
//! the staged database (`integrity_check`, `user_version`) and switch it to
//! WAL, then write the `.restore-in-progress` marker with the full replacement
//! plan. No live file is touched; the frontend then relaunches.
//!
//! Phase 2 (`apply_pending_restore`, startup, before the frontend opens the
//! database): move whatever is at each destination now (for the database also
//! its -wal/-shm/-journal) into `pre-restore-<ts>/`, move staged files into
//! place (database last), rewrite the marker as `Done`, then delete marker and
//! staging dir. A `Done` marker that survives (e.g. a Windows sharing
//! violation) only means cleanup on the next launch, never a rollback.
//!
//! Marker rule: the marker is written before every step that touches a live
//! file. If the marker cannot be written, no live file is touched and the app
//! starts with `RestoreStatus::Stuck`. The only exception is putting the old
//! database back once the attempt limit is exceeded, which only moves data
//! towards a safer state and is idempotent.
//!
//! Rollback never deletes a live file: whatever has to make room goes to
//! `quarantine-<ts>/`. At startup it also refuses (Stuck) to displace a file
//! that is no longer the untouched staged copy, so user work is never overwritten.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::ZipArchive;

use crate::app_config_dir;
use crate::backup::{safe_entry_name, MANIFEST};
use crate::secrets::scrub_json_secrets;

pub const SCHEMA_VERSION: i64 = 6; // keep in sync with src/lib/schema.ts:9
const MARKER: &str = ".restore-in-progress";
const STAGING: &str = ".restore-staging";
const DB: &str = "paper-field.db";
const NO_DB: &str = "找不到原来的数据库，恢复标记已保留，请打开原数据目录手动处理";
const MARKER_STUCK: &str = "无法清除恢复标记，请退出应用后删除数据目录中的 .restore-in-progress";
const SIDECARS: [&str; 3] = ["paper-field.db-wal", "paper-field.db-shm", "paper-field.db-journal"];
const MAX_ATTEMPTS: u32 = 2;
const STALE_MS: u128 = 10 * 60 * 1000;
/// Sanity cap on what one backup may unpack to (zip bombs). A large PDF library
/// legitimately runs to several GiB; free disk space is checked separately.
const MAX_UNPACKED: u64 = 8 << 30;
/// Left free after staging, so the live database and the OS can still write.
const DISK_HEADROOM: u64 = 64 << 20;
/// keyOrigin given to every restored LLM provider. `llm::key_origin` only ever
/// yields lower-case ASCII (a URL origin, or the lower-cased base URL), so a value
/// with upper-case letters never matches: the stored key for that provider id is
/// refused until the user re-enters it. Empty would not do: `bind_legacy_key_origins`
/// binds an empty origin to whatever baseUrl the backup carries.
const RESTORED_KEY_ORIGIN: &str = "从备份恢复，需重新填写 Key";
/// Settings and the manifest are read into memory.
const MAX_SMALL_ENTRY: u64 = 16 << 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Staged but the user has not confirmed yet; startup discards it, never swaps.
    Previewed,
    Staged,
    Swapping,
    /// Swap or rollback finished; a leftover marker only means cleanup.
    Done,
}

/// One replacement. Paths are relative: `src` to staging, `dest` to the data
/// dir, `backup` to the pre-restore dir (`None` = dest did not exist at stage
/// time; the swap itself backs up whatever exists by then).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanItem {
    pub src: Option<String>,
    pub dest: String,
    pub backup: Option<String>,
    /// Staged file's size and mtime (a rename keeps both): rollback only
    /// displaces a dest that still matches. Absent in older markers.
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mtime_ns: Option<u128>,
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
/// Also taken by library import and backup, which read or write `library/`.
pub(crate) static OP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(test)]
thread_local! {
    /// Simulates a locked marker (Windows sharing violation): how many more
    /// marker writes succeed, and whether removing it fails.
    static MARKER_FAULT: std::cell::Cell<(u32, bool)> = const { std::cell::Cell::new((u32::MAX, false)) };
}

fn write_marker(dir: &Path, marker: &Marker) -> Result<(), String> {
    #[cfg(test)]
    {
        let (left, keep) = MARKER_FAULT.with(|f| f.get());
        if left == 0 {
            return Err("marker locked".into());
        }
        MARKER_FAULT.with(|f| f.set((left - 1, keep)));
    }
    let json = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    crate::io_util::atomic_write(&dir.join(MARKER), &json)
}

fn read_marker(dir: &Path) -> Option<Result<Marker, String>> {
    let raw = fs::read(dir.join(MARKER)).ok()?;
    Some(serde_json::from_slice(&raw).map_err(|e| e.to_string()))
}

fn remove_marker(dir: &Path) {
    #[cfg(test)]
    if MARKER_FAULT.with(|f| f.get().1) {
        return;
    }
    let _ = fs::remove_file(dir.join(MARKER));
}

fn done_marker(dir: &Path) -> bool {
    matches!(read_marker(dir), Some(Ok(m)) if m.stage == Stage::Done)
}

/// A marker that still needs handling (even an unreadable one); `Done` does not.
fn pending_marker(dir: &Path) -> bool {
    dir.join(MARKER).exists() && !done_marker(dir)
}

/// Exists, without following symlinks.
fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn is_empty_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) && fs::read_dir(path).is_ok_and(|mut rd| rd.next().is_none())
}

/// Size and mtime (ns since epoch).
fn file_stamp(path: &Path) -> Option<(u64, u128)> {
    let meta = fs::symlink_metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some((meta.len(), mtime))
}

/// The database's -wal/-shm/-journal present right now.
fn live_sidecars(dir: &Path) -> Vec<&'static str> {
    SIDECARS.iter().copied().filter(|s| present(&dir.join(s))).collect()
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

/// Settings in a backup are untrusted (it may be shared or edited): every
/// network destination they name stays off until the user re-enables it.
/// Returns the file to stage and, when something was switched off, what to tell
/// the user; `None` skips the file (not a v2 settings file), keeping the live one.
fn neutralize_settings(dest: &str, raw: &str) -> Option<(String, Option<&'static str>)> {
    let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let note = match dest {
        "llm-settings.json" => neutralize_llm(&mut value)?,
        "mineru-settings.json" => neutralize_mineru(&mut value)?,
        _ => return Some((raw.to_string(), None)),
    };
    Some((serde_json::to_string_pretty(&value).ok()?, note))
}

fn is_v2(value: &serde_json::Value) -> bool {
    value.is_object() && value.get("version").and_then(serde_json::Value::as_u64) == Some(2)
}

/// Every provider: disabled (keyless ones would otherwise send papers to the
/// backup's baseUrl) and its saved key unusable until re-entered.
fn neutralize_llm(value: &mut serde_json::Value) -> Option<Option<&'static str>> {
    if !is_v2(value) {
        return None;
    }
    let providers = value.get_mut("providers")?.as_array_mut()?;
    for provider in providers.iter_mut() {
        let provider = provider.as_object_mut()?;
        provider.insert("enabled".into(), false.into());
        provider.insert("apiKey".into(), "".into());
        provider.insert("keyOrigin".into(), RESTORED_KEY_ORIGIN.into());
    }
    Some((!providers.is_empty()).then_some("LLM 提供商已全部停用，已保存的 API Key 需要重新填写"))
}

/// SSH off (it uploads every parsed PDF to the backup's host). The official API
/// has a fixed host and its token never leaves the keychain, so it stays as is;
/// the local socket stays unless its path points off this machine.
fn neutralize_mineru(value: &mut serde_json::Value) -> Option<Option<&'static str>> {
    if !is_v2(value) {
        return None;
    }
    let mut changed = false;
    let mut disable = |section: &mut serde_json::Value, keep: bool| -> Option<()> {
        let section = section.as_object_mut()?;
        if section.get("enabled") != Some(&serde_json::Value::Bool(false)) && !keep {
            section.insert("enabled".into(), false.into());
            changed = true;
        }
        Some(())
    };
    if let Some(ssh) = value.get_mut("ssh") {
        disable(ssh, false)?;
    }
    if let Some(local) = value.get_mut("local") {
        let socket = local.get("socketPath").and_then(serde_json::Value::as_str).unwrap_or("");
        let keep = !crate::library::is_remote_or_device_path(socket) && !socket.contains("://");
        disable(local, keep)?;
    }
    Some(changed.then_some("MinerU 的 SSH 远程解析已停用"))
}

/// One line for the confirm dialog and the post-restore notice.
fn settings_notice(notes: &[&str]) -> Option<String> {
    (!notes.is_empty()).then(|| format!("为安全起见，备份中的设置没有直接生效：{}。请在设置中核对地址后再启用。", notes.join("；")))
}

/// Duplicate check key: `library/a.pdf` and `library\A.pdf` are one file on Windows/macOS.
fn fold_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.replace('\\', "/").nfc().collect::<String>().to_lowercase()
}

/// Streams one entry, refusing more bytes than its header declares.
fn copy_entry(entry: &mut impl Read, declared: u64, out: &mut impl Write, name: &str) -> Result<(), String> {
    let copied = std::io::copy(&mut entry.by_ref().take(declared.saturating_add(1)), out)
        .map_err(|e| format!("读取备份中的 {name} 失败：{e}"))?;
    if copied > declared {
        return Err(format!("备份中的 {name} 实际大小超过记录，已拒绝"));
    }
    Ok(())
}

fn read_small(entry: &mut impl Read, declared: u64, name: &str) -> Result<Vec<u8>, String> {
    if declared > MAX_SMALL_ENTRY {
        return Err(format!("备份中的 {name} 过大，已拒绝"));
    }
    let mut bytes = Vec::new();
    copy_entry(entry, declared, &mut bytes, name)?;
    Ok(bytes)
}

/// `create_new`: two entries can never end up in one staged file.
fn create_staged(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("写入暂存文件失败：{e}"))
}

fn manifest_pdfs(bytes: &[u8]) -> Result<u64, String> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("pdfs")?.as_u64())
        .ok_or_else(|| "备份清单 manifest.json 已损坏".to_string())
}

/// Relative dest paths written to staging, and what restored settings had switched off.
#[derive(Debug)]
struct Unpacked {
    written: Vec<String>,
    notes: Vec<&'static str>,
}

/// Unpacks `src` into `staging`.
fn unpack(src: &Path, staging: &Path) -> Result<Unpacked, String> {
    unpack_capped(src, staging, MAX_UNPACKED)
}

fn entry_name<R: std::io::Read + ?Sized>(entry: &zip::read::ZipFile<'_, R>) -> Option<String> {
    entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// Available bytes on the volume holding `dir`; `None` when unknown.
#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs is plain old data; zeroed is a valid value for it.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: path is NUL-terminated and outlives the call; stat is a valid out pointer.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)] // u32 on some platforms
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut avail = 0u64;
    // SAFETY: wide is NUL-terminated; ULARGE_INTEGER is a u64; the other out pointers may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(avail)
}

#[cfg(not(any(unix, windows)))]
fn free_bytes(_: &Path) -> Option<u64> {
    None
}

/// Unknown free space is not a reason to refuse: unpacking then fails on its own.
fn check_free_space(needed: u64, free: Option<u64>) -> Result<(), String> {
    match free {
        Some(free) if needed.saturating_add(DISK_HEADROOM) > free => Err(format!(
            "磁盘空间不足：恢复需要约 {} MB，可用 {} MB，请先清理磁盘",
            needed.saturating_add(DISK_HEADROOM).div_ceil(1 << 20),
            free >> 20
        )),
        _ => Ok(()),
    }
}

fn unpack_capped(src: &Path, staging: &Path, cap: u64) -> Result<Unpacked, String> {
    let file = File::open(src).map_err(|e| format!("无法打开备份：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("备份不是有效的 zip：{e}"))?;
    // Declared sizes from the central directory, before anything is written.
    let mut needed = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        if entry_name(&entry).is_some_and(|name| map_entry(&name).is_some()) {
            needed = needed.saturating_add(entry.size());
        }
    }
    if needed > cap {
        return Err("备份解压后过大，已拒绝".into());
    }
    check_free_space(needed, free_bytes(staging))?;
    let mut written = Vec::new();
    let mut notes = Vec::new();
    let mut seen = HashSet::new();
    let mut expected_pdfs = None;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(name) = entry_name(&entry) else {
            continue;
        };
        if safe_entry_name(&name).is_none() {
            return Err(format!("备份包含不安全路径：{name}"));
        }
        let dest = map_entry(&name);
        if dest.is_none() && name != MANIFEST {
            continue;
        }
        if !seen.insert(fold_name(dest.as_deref().unwrap_or(MANIFEST))) {
            return Err(format!("备份中有重复的文件：{name}"));
        }
        let declared = entry.size();
        total = total.saturating_add(declared);
        if total > cap {
            return Err("备份解压后过大，已拒绝".into());
        }
        let Some(dest) = dest else {
            expected_pdfs = Some(manifest_pdfs(&read_small(&mut entry, declared, &name)?)?);
            continue;
        };
        if name.starts_with("settings/") {
            let bytes = read_small(&mut entry, declared, &name)?;
            let scrubbed = scrub_json_secrets(&String::from_utf8_lossy(&bytes));
            // Not a settings file this version understands: keep the live one.
            let Some((safe, note)) = neutralize_settings(&dest, &scrubbed) else { continue };
            notes.extend(note);
            let mut out = create_staged(&staging.join(&dest))?;
            out.write_all(safe.as_bytes()).map_err(|e| format!("写入暂存文件失败：{e}"))?;
            out.sync_all().map_err(|e| format!("写入暂存文件失败：{e}"))?;
            written.push(dest);
            continue;
        }
        let mut out = create_staged(&staging.join(&dest))?;
        copy_entry(&mut entry, declared, &mut out, &name)?;
        out.sync_all().map_err(|e| format!("写入暂存文件失败：{e}"))?;
        written.push(dest);
    }
    if !written.iter().any(|d| d == DB) {
        return Err("备份里没有 paper-field.db，不是本应用的备份".into());
    }
    // Backups without a manifest come from older versions: accepted as before.
    if let Some(expected) = expected_pdfs {
        let pdfs = written.iter().filter(|d| d.starts_with("library/")).count() as u64;
        if pdfs != expected {
            return Err(format!("备份与清单不符：清单记录 {expected} 个 PDF，实际有 {pdfs} 个，备份可能不完整，已拒绝恢复"));
        }
    }
    Ok(Unpacked { written, notes })
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
    /// Restored settings that were switched off (see `neutralize_settings`).
    #[serde(default)]
    pub settings_notice: Option<String>,
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

/// `VACUUM INTO` writes a rollback-journal database; the live one runs in WAL.
async fn enable_wal(db: &Path) -> Result<(), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    let options = SqliteConnectOptions::new().filename(db).create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("备份中的数据库无法打开：{e}"))?;
    let result = match sqlx::query("PRAGMA journal_mode=WAL").fetch_one(&pool).await {
        Ok(row) => match row.try_get::<String, _>(0) {
            Ok(mode) if mode.eq_ignore_ascii_case("wal") => Ok(()),
            Ok(mode) => Err(format!("备份中的数据库无法切换到 WAL 模式（{mode}）")),
            Err(e) => Err(format!("备份中的数据库无法切换到 WAL 模式：{e}")),
        },
        Err(e) => Err(format!("备份中的数据库无法切换到 WAL 模式：{e}")),
    };
    // Closing the last connection checkpoints and removes -wal/-shm.
    pool.close().await;
    result
}

/// Builds the plan: everything except the database first, then the database.
/// Records each staged file's size and mtime; sidecars are found at swap time.
fn build_plan(dir: &Path, staging: &Path, staged: &[String]) -> Vec<PlanItem> {
    let item = |dest: &str| {
        let stamp = file_stamp(&staging.join(dest));
        PlanItem {
            src: Some(dest.to_string()),
            dest: dest.to_string(),
            backup: present(&dir.join(dest)).then(|| dest.to_string()),
            size: stamp.map(|s| s.0),
            mtime_ns: stamp.map(|s| s.1),
        }
    };
    let mut plan: Vec<PlanItem> = staged.iter().filter(|d| *d != DB).map(|d| item(d)).collect();
    plan.push(item(DB));
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
    if done_marker(dir) {
        finish(dir);
    }
    if dir.join(MARKER).exists() {
        return Err("上一次恢复还没处理完，请先重启应用".into());
    }
    let staging = dir.join(STAGING);
    let _ = remove_dir_off_thread(staging.clone()).await;
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = async {
        let Unpacked { written: staged, notes } = unpack(src, &staging)?;
        let (papers, latest_updated_at) = check_staged_db(&staging.join(DB)).await?;
        enable_wal(&staging.join(DB)).await?;
        let summary = BackupSummary {
            papers,
            latest_updated_at,
            pdfs: staged.iter().filter(|d| d.to_ascii_lowercase().ends_with(".pdf")).count(),
            zip_bytes: fs::metadata(src).map(|m| m.len()).unwrap_or(0),
            settings_notice: settings_notice(&notes),
        };
        let marker = Marker {
            stage: Stage::Previewed,
            created_ms: now_ms(),
            attempts: 0,
            pre: format!("pre-restore-{}", now_ms()),
            plan: build_plan(dir, &staging, &staged),
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

/// 弹出打开对话框选备份 zip 并暂存；用户取消时返回 None。路径只来自系统对话框。
#[tauri::command]
pub async fn restore_library_backup(app: AppHandle) -> Result<Option<BackupSummary>, String> {
    let kind = crate::platform::PickKind::OpenFile { filter: ("Zip", &["zip"]) };
    let Some(src) = crate::platform::pick_path(&app, "恢复文库", kind).await? else {
        return Ok(None);
    };
    stage_restore(&app_config_dir(&app)?, &src).await.map(Some)
}

/// Where the swap puts `item`'s old file inside the pre-restore dir.
fn saved_path(pre: &Path, item: &PlanItem) -> PathBuf {
    pre.join(item.backup.as_deref().unwrap_or(&item.dest))
}

/// `dest` is still exactly the staged file the swap moved in. For the database
/// any -wal/-shm/-journal means it has been opened since. Old markers carry no
/// record, so nothing they moved counts as untouched.
fn untouched(dir: &Path, item: &PlanItem) -> bool {
    let (Some(size), Some(mtime)) = (item.size, item.mtime_ns) else { return false };
    if item.dest == DB && !live_sidecars(dir).is_empty() {
        return false;
    }
    file_stamp(&dir.join(&item.dest)) == Some((size, mtime))
}

/// `quarantine-<ms>/`, created on first use: rollback moves live files here
/// (same relative path) instead of deleting them.
#[derive(Default)]
struct Quarantine(Option<PathBuf>);

impl Quarantine {
    fn take(&mut self, dir: &Path, rel: &str) -> Result<(), String> {
        if self.0.is_none() {
            let mut ms = now_ms();
            loop {
                let root = dir.join(format!("quarantine-{ms}"));
                match fs::create_dir(&root) {
                    Ok(()) => {
                        self.0 = Some(root);
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ms += 1,
                    Err(e) => return Err(format!("无法创建隔离目录：{e}")),
                }
            }
        }
        let root = self.0.as_ref().expect("created above");
        move_file(&dir.join(rel), &root.join(rel))
    }
}

/// Undo by looking at what is actually on disk for each item; safe to repeat.
/// Never deletes: whatever must make room goes to quarantine. With `verify`
/// (a Swapping marker found at startup, files may have been used since) it
/// refuses, before moving anything, to displace a dest that is not the
/// untouched staged file. Without it (swap failed in this launch, or the user
/// abandons) such files are quarantined too.
fn rollback(dir: &Path, marker: &Marker, verify: bool) -> Result<(), String> {
    let pre = dir.join(&marker.pre);
    let staging = dir.join(STAGING);
    // Staging is kept while a non-Done marker exists, so "gone from staging" = moved in.
    let moved_in = |item: &PlanItem| item.src.as_ref().is_some_and(|s| !present(&staging.join(s)));
    if verify {
        for item in &marker.plan {
            if present(&saved_path(&pre, item)) && moved_in(item) && present(&dir.join(&item.dest)) && !untouched(dir, item) {
                return Err(format!("{} 在恢复后被改动过，不自动回滚", item.dest));
            }
        }
    }
    let mut quarantine = Quarantine::default();
    for item in marker.plan.iter().rev() {
        let dest = dir.join(&item.dest);
        let is_db = item.dest == DB;
        let saved = saved_path(&pre, item);
        let displace = if present(&saved) {
            true
        } else {
            // Nothing to bring back: only a file the restore created goes. A dest that
            // is not the staged copy is the original after an earlier rollback, or
            // user work; old markers fall back to their plan when the user abandons.
            moved_in(item) && (untouched(dir, item) || !verify && item.size.is_none() && item.backup.is_none())
        };
        if displace {
            if present(&dest) {
                quarantine.take(dir, &item.dest)?;
            }
            if is_db {
                // they belong to the database just moved away, or to none
                for s in live_sidecars(dir) {
                    quarantine.take(dir, s)?;
                }
            }
            if present(&saved) {
                move_file(&saved, &dest)?;
            }
        }
        if is_db {
            // old database first, then its sidecars (same order ensure_db uses)
            for s in SIDECARS {
                let old = pre.join(s);
                if present(&old) {
                    if present(&dir.join(s)) {
                        quarantine.take(dir, s)?;
                    }
                    move_file(&old, &dir.join(s))?;
                }
            }
        }
    }
    Ok(())
}

/// Backs up whatever exists at each dest right now (the plan is frozen at stage
/// time; files may have appeared since), then moves the staged file in.
fn swap(dir: &Path, marker: &Marker) -> Result<(), String> {
    let pre = dir.join(&marker.pre);
    let staging = dir.join(STAGING);
    for item in &marker.plan {
        let dest = dir.join(&item.dest);
        if item.dest == DB {
            // sidecars first: a crash in between never leaves the old WAL live without its db
            for s in live_sidecars(dir) {
                move_file(&dir.join(s), &pre.join(s))?;
            }
        }
        if present(&dest) {
            move_file(&dest, &saved_path(&pre, item))?;
        }
        if let Some(src) = &item.src {
            move_file(&staging.join(src), &dest)?;
        }
    }
    Ok(())
}

/// Marker first, then staging; staging stays while a non-Done marker survives,
/// since rollback reads "still staged" as "never moved in".
fn finish(dir: &Path) {
    remove_marker(dir);
    if !pending_marker(dir) {
        let _ = fs::remove_dir_all(dir.join(STAGING));
    }
}

/// Terminal step: record `Done` before cleaning up, so a marker that cannot be
/// deleted never leads to a rollback. False only when the marker can neither be
/// rewritten nor removed.
fn conclude(dir: &Path, marker: &mut Marker) -> bool {
    marker.stage = Stage::Done;
    let recorded = write_marker(dir, marker).is_ok();
    finish(dir);
    recorded || !dir.join(MARKER).exists()
}

/// Over the attempt limit: make sure a database exists, without writing the marker.
fn give_up(dir: &Path, marker: &Marker) -> RestoreStatus {
    let db_available = ensure_db(dir, Some(&marker.pre));
    RestoreStatus::Stuck { pre: abs(dir, &marker.pre), db_available }
}

/// Old database expected after rollback: the plan saw one, or the swap moved
/// one aside. Check before rolling back.
fn expects_db(dir: &Path, marker: &Marker) -> bool {
    marker.plan.iter().any(|i| i.dest == DB && i.backup.is_some())
        || !marker.pre.is_empty() && present(&dir.join(&marker.pre).join(DB))
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
    match marker.stage {
        // Finished earlier, only the marker could not be deleted: clean up, never
        // roll back. The launch that wrote it already reported the outcome.
        Stage::Done => {
            finish(dir);
            return RestoreStatus::None;
        }
        // The app quit or crashed while the confirm dialog was open: nothing was
        // moved yet, so dropping the marker and staging is a complete undo.
        Stage::Previewed => {
            finish(dir);
            return RestoreStatus::None;
        }
        Stage::Staged if now.saturating_sub(marker.created_ms) > STALE_MS => {
            return RestoreStatus::PendingConfirm;
        }
        _ => {}
    }
    marker.attempts += 1;
    if marker.attempts > MAX_ATTEMPTS {
        return give_up(dir, &marker);
    }
    let stuck = |m: &Marker| RestoreStatus::Stuck { pre: abs(dir, &m.pre), db_available: dir.join(DB).exists() };
    let mut verify = true;
    if marker.stage == Stage::Staged {
        let pre = dir.join(&marker.pre);
        // A crash between creating pre/ and writing Swapping leaves it empty: reuse it.
        if fs::create_dir(&pre).is_err() && !is_empty_dir(&pre) {
            return stuck(&marker);
        }
        marker.stage = Stage::Swapping;
        if write_marker(dir, &marker).is_err() {
            let _ = fs::remove_dir(&pre);
            return stuck(&marker);
        }
        if swap(dir, &marker).is_ok() {
            let (pre, summary) = (abs(dir, &marker.pre), marker.summary.clone());
            if conclude(dir, &mut marker) {
                return RestoreStatus::Restored { pre, summary };
            }
            // Still says Swapping: the next launch rolls back, so keep the UI closed.
            return stuck(&marker);
        }
        // Everything here was moved by this launch and never opened.
        verify = false;
    } else if write_marker(dir, &marker).is_err() {
        return stuck(&marker);
    }
    let need_db = expects_db(dir, &marker);
    match rollback(dir, &marker, verify) {
        Ok(()) if need_db && !ensure_db(dir, Some(&marker.pre)) => stuck(&marker),
        Ok(()) => {
            // A marker left at Swapping is fine here: rolling back again is a no-op.
            conclude(dir, &mut marker);
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
pub async fn restore_confirm_pending(app: AppHandle) -> Result<(), String> {
    confirm_pending(&app_config_dir(&app)?).await
}

/// Holds the lock across read and write so an abandon can't slip in between
/// and have its cleared marker written back.
pub async fn confirm_pending(dir: &Path) -> Result<(), String> {
    let _guard = OP_LOCK.lock().await;
    let Some(Ok(mut marker)) = read_marker(dir) else { return Err("没有待确认的恢复".into()) };
    if marker.stage != Stage::Staged {
        return Err("没有待确认的恢复".into());
    }
    marker.created_ms = now_ms();
    write_marker(dir, &marker)
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

/// One restorable library copy or stray sidecar directory kept after a restore.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreDir {
    pub name: String,
    pub path: String,
    pub created_ms: u128,
    pub bytes: u64,
    pub has_db: bool,
    /// Stray WAL/SHM files moved aside during rollback, not a library copy.
    pub orphans: bool,
}

const PRE_BUSY: &str = "恢复还没处理完，暂不能清理原数据副本";

/// `pre-restore-<digits>` or `.restore-orphans-<digits>` exactly.
fn pre_name_ms(name: &str) -> Option<u128> {
    let digits = name
        .strip_prefix("pre-restore-")
        .or_else(|| name.strip_prefix(".restore-orphans-"))?;
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
    let busy = pending_marker(dir);
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
                        orphans: name.starts_with(".restore-orphans-"),
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
    // Any marker but a Done one (even unreadable) means some pre dir may still be a rollback source.
    if pending_marker(dir) {
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

#[cfg(test)]
static LIST_PRE_THREAD: Mutex<Option<std::thread::ThreadId>> = Mutex::new(None);

/// `tree_bytes` walks every file of every copy: keep it off the calling thread.
async fn list_pre_off_thread(dir: PathBuf) -> Result<PreList, String> {
    let (dirs, busy) = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        {
            *LIST_PRE_THREAD.lock().unwrap() = Some(std::thread::current().id());
        }
        list_pre(&dir)
    })
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
    let marker = match read_marker(dir) {
        None => None,
        // The user's explicit choice: files changed since the swap are not
        // refused but quarantined like the rest; nothing is deleted.
        Some(Ok(marker)) => {
            if marker.stage != Stage::Done {
                let need_db = expects_db(dir, &marker);
                rollback(dir, &marker, false)?;
                if need_db && !ensure_db(dir, Some(&marker.pre)) {
                    return Err(NO_DB.into());
                }
            }
            Some(marker)
        }
        // Unreadable marker: no plan. Bring back the newest moved-aside database
        // if the live one is gone; with no pre-restore-* dir nothing was moved.
        Some(Err(_)) => {
            if !ensure_db(dir, None) && !pre_dirs(dir).is_empty() {
                return Err(NO_DB.into());
            }
            Some(Marker { stage: Stage::Done, created_ms: now_ms(), attempts: 0, pre: String::new(), plan: Vec::new(), summary: None })
        }
    };
    match marker {
        Some(mut marker) => {
            if !conclude(dir, &mut marker) {
                return Err(MARKER_STUCK.into());
            }
        }
        None => finish(dir),
    }
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(RestoreStatus::None);
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StagedTitle {
    pub id: String,
    pub title: String,
    pub title_zh: Option<String>,
}

pub async fn read_staged_titles(db: &Path) -> Result<Vec<StagedTitle>, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    let options = SqliteConnectOptions::new().filename(db).read_only(true).create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("无法打开暂存文库：{e}"))?;
    let result = sqlx::query("SELECT id, title, title_zh FROM papers WHERE id != '' ORDER BY id")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("无法读取暂存文库标题：{e}"));
    pool.close().await;
    let rows = result?;
    let mut out = Vec::new();
    for row in rows {
        out.push(StagedTitle {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            title: row.try_get("title").map_err(|e| e.to_string())?,
            title_zh: row.try_get("title_zh").ok().flatten(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn restore_staged_titles(app: AppHandle) -> Result<Vec<StagedTitle>, String> {
    let db = app_config_dir(&app)?.join(STAGING).join(DB);
    read_staged_titles(&db).await
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

    #[test]
    fn read_staged_titles_lists_rows_and_skips_blank_ids() {
        let path = std::env::temp_dir().join(format!("pf-staged-titles-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
            sqlx::query("CREATE TABLE papers (id TEXT, title TEXT, title_zh TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO papers (id, title, title_zh) VALUES ('b', 'Keep', '保留'), ('a', 'File.pdf', NULL), ('', 'skip', NULL)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
            let rows = read_staged_titles(&path).await.unwrap();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].id, "a");
            assert_eq!(rows[0].title, "File.pdf");
            assert_eq!(rows[1].title_zh.as_deref(), Some("保留"));
        });
        let _ = std::fs::remove_file(&path);
    }

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
    fn orphan_sidecar_dirs_are_listed_and_deletable() {
        let live = restored_live("restore-orphans");
        let orphan = live.join(".restore-orphans-77");
        fs::create_dir(&orphan).unwrap();
        fs::write(orphan.join("paper-field.db-wal"), b"stray").unwrap();

        let (dirs, busy) = list_pre(&live);
        assert!(!busy);
        let listed = dirs
            .iter()
            .find(|d| d.name == ".restore-orphans-77")
            .expect("orphan listed");
        assert!(listed.orphans && !listed.has_db && listed.bytes == 5);
        assert!(dirs
            .iter()
            .filter(|d| d.name.starts_with("pre-restore-"))
            .all(|d| !d.orphans));

        for bad in [
            ".restore-orphans-",
            ".restore-orphans-7x",
            ".restore-orphans-1/..",
        ] {
            assert!(
                tauri::async_runtime::block_on(delete_pre(&live, bad)).is_err(),
                "{bad}"
            );
        }
        tauri::async_runtime::block_on(delete_pre(&live, ".restore-orphans-77")).unwrap();
        assert!(!orphan.exists());
        assert!(live.join(DB).exists(), "live database untouched");
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
    fn confirm_pending_after_abandon_does_not_write_marker_back() {
        let (live, zip) = setup("p10-confirm-after-abandon");
        stage(&live, &zip).unwrap();
        tauri::async_runtime::block_on(confirm_pending(&live)).unwrap();
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_eq!(tauri::async_runtime::block_on(confirm_pending(&live)), Err("没有待确认的恢复".into()));
        assert!(!live.join(MARKER).exists());
    }

    #[test]
    fn confirm_pending_waits_for_lock_and_sees_abandon() {
        let (live, zip) = setup("p10-confirm-lock");
        stage(&live, &zip).unwrap();
        let guard = OP_LOCK.blocking_lock();
        let l2 = live.clone();
        let handle = std::thread::spawn(move || tauri::async_runtime::block_on(confirm_pending(&l2)));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!handle.is_finished(), "confirm must wait for the restore lock");
        // An abandon runs while confirm is waiting (we hold the lock for it).
        abandon_locked(&live).unwrap();
        drop(guard);
        assert_eq!(handle.join().unwrap(), Err("没有待确认的恢复".into()));
        assert!(!live.join(MARKER).exists(), "abandoned marker must not come back");
    }

    #[test]
    fn list_pre_runs_off_the_calling_thread() {
        let live = restored_live("p9-list-offthread");
        let caller = std::thread::current().id();
        *LIST_PRE_THREAD.lock().unwrap() = None;
        let list = tauri::async_runtime::block_on(list_pre_off_thread(live.clone())).unwrap();
        let walker = LIST_PRE_THREAD.lock().unwrap().take().expect("walk ran inside spawn_blocking");
        assert_ne!(walker, caller, "size walk must not run on the caller");
        assert_eq!(list.dirs, list_pre(&live).0);
        assert!(!list.busy);
    }

    /// `(marker writes that still succeed, removal fails)` for this test thread.
    fn marker_fault(left: u32, keep: bool) {
        MARKER_FAULT.with(|f| f.set((left, keep)));
    }

    fn add_rows(path: &Path, n: i64) {
        tauri::async_runtime::block_on(async {
            let o = SqliteConnectOptions::new().filename(path);
            let p = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap();
            for _ in 0..n {
                sqlx::query("INSERT INTO papers DEFAULT VALUES").execute(&p).await.unwrap();
            }
            p.close().await;
        });
    }

    fn quarantines(live: &Path) -> Vec<PathBuf> {
        fs::read_dir(live).unwrap().flatten().map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("quarantine-")).collect()
    }

    fn is_wal(db: &Path) -> bool {
        let header = fs::read(db).unwrap();
        header[18] == 2 && header[19] == 2
    }

    /// Fully swapped, but the marker could neither become Done nor be deleted.
    fn swapped_with_stuck_marker(n: &str) -> (PathBuf, PathBuf) {
        let (live, zip) = setup(n);
        stage(&live, &zip).unwrap();
        marker_fault(1, true);
        let status = apply_pending_restore_at(&live, now_ms());
        marker_fault(u32::MAX, false);
        assert!(matches!(status, RestoreStatus::Stuck { db_available: true, .. }), "{status:?}");
        let m = read_marker(&live).unwrap().unwrap();
        assert_eq!(m.stage, Stage::Swapping);
        // not rows(): a read-only open of the WAL db could leave sidecars behind
        assert!(m.plan.iter().all(|i| untouched(&live, i)), "swap itself went through");
        assert!(live.join(STAGING).exists(), "staging kept while the marker says Swapping");
        (live, zip)
    }

    #[test]
    fn surviving_done_marker_is_cleaned_up_and_never_rolled_back() {
        let (live, zip) = setup("p104-done");
        stage(&live, &zip).unwrap();
        marker_fault(u32::MAX, true); // marker can be rewritten but not deleted
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        marker_fault(u32::MAX, false);
        assert_eq!(read_marker(&live).unwrap().unwrap().stage, Stage::Done);
        assert!(!live.join(STAGING).exists());
        assert!(!list_pre(&live).1, "a Done marker does not block pre-restore cleanup");
        // the user works on the restored library before the next launch
        add_rows(&live.join(DB), 5);
        assert_eq!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::None);
        assert_eq!(rows(&live.join(DB)), 12, "edits survive");
        assert_eq!(fs::read_to_string(live.join("library/shared.pdf")).unwrap(), "new");
        assert!(!live.join(MARKER).exists() && quarantines(&live).is_empty());
    }

    #[test]
    fn done_marker_does_not_block_new_restore_or_abandon() {
        let (live, zip) = setup("p104-done-ops");
        stage(&live, &zip).unwrap();
        marker_fault(u32::MAX, true);
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        marker_fault(u32::MAX, false);
        let pre = list_pre(&live).0[0].name.clone();
        tauri::async_runtime::block_on(delete_pre(&live, &pre)).expect("Done marker: no rollback source left");
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert!(!live.join(MARKER).exists());
        assert_eq!(rows(&live.join(DB)), 7, "abandoning a finished restore undoes nothing");
        assert!(quarantines(&live).is_empty());
        // a Done marker left behind again: a new restore just cleans it up
        let done = Marker { stage: Stage::Done, created_ms: 1, attempts: 1, pre: "pre-restore-1".into(), plan: vec![], summary: None };
        write_marker(&live, &done).unwrap();
        stage_summary(&live, &zip).expect("a Done marker is only cleanup");
        assert_eq!(read_marker(&live).unwrap().unwrap().stage, Stage::Previewed);
    }

    #[test]
    fn marker_that_cannot_be_finalised_is_stuck_then_rolls_back_into_quarantine() {
        let (live, _) = swapped_with_stuck_marker("p104-stuck");
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::RolledBack { .. }), "{status:?}");
        assert_original(&live);
        assert!(!live.join(MARKER).exists());
        let q = quarantines(&live);
        assert_eq!(q.len(), 1);
        assert_eq!(fs::read_to_string(q[0].join("library/new.pdf")).unwrap(), "new-only");
        assert_eq!(fs::read_to_string(q[0].join("library/shared.pdf")).unwrap(), "new");
        assert_eq!(rows(&q[0].join(DB)), 7, "restored db kept, not deleted");
    }

    #[test]
    fn startup_refuses_to_roll_back_files_changed_since_swap() {
        let (live, _) = swapped_with_stuck_marker("p104-edited-pdf");
        fs::write(live.join("library/shared.pdf"), "user edit").unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { db_available: true, .. }), "{status:?}");
        assert_eq!(fs::read_to_string(live.join("library/shared.pdf")).unwrap(), "user edit");
        assert_eq!(rows(&live.join(DB)), 7, "nothing rolled back halfway");
        assert!(quarantines(&live).is_empty());

        let (live, _) = swapped_with_stuck_marker("p104-edited-db");
        add_rows(&live.join(DB), 2);
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { .. }), "{status:?}");
        assert_eq!(rows(&live.join(DB)), 9);
        // the user gives up explicitly: old files back, their edits quarantined
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
        let q = quarantines(&live);
        assert_eq!(rows(&q[0].join(DB)), 9);
        assert!(!live.join(MARKER).exists());
    }

    #[test]
    fn old_marker_without_stamps_is_not_rolled_back_automatically() {
        let (live, _) = swapped_with_stuck_marker("p104-old-marker");
        let mut m = read_marker(&live).unwrap().unwrap();
        for item in &mut m.plan {
            (item.size, item.mtime_ns) = (None, None);
        }
        write_marker(&live, &m).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::Stuck { .. }), "{status:?}");
        assert_eq!(rows(&live.join(DB)), 7);
        assert!(quarantines(&live).is_empty());
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();
        assert_original(&live);
    }

    #[test]
    fn old_marker_formats_still_parse() {
        let json = r#"{"stage":"swapping","created_ms":1,"attempts":1,"pre":"pre-restore-1",
            "plan":[{"src":null,"dest":"paper-field.db-wal","backup":"paper-field.db-wal"},
                    {"src":"paper-field.db","dest":"paper-field.db","backup":"paper-field.db"}]}"#;
        let m: Marker = serde_json::from_str(json).unwrap();
        assert!(m.plan.iter().all(|i| i.size.is_none() && i.mtime_ns.is_none()));
        let done: Marker = serde_json::from_str(&json.replace("swapping", "done")).unwrap();
        assert_eq!(done.stage, Stage::Done);
    }

    #[test]
    fn rollback_after_swap_failure_quarantines_what_it_moved_in() {
        let (live, zip) = setup("p104-swapfail");
        stage(&live, &zip).unwrap();
        fs::remove_file(live.join(STAGING).join("library/shared.pdf")).unwrap();
        let status = apply_pending_restore_at(&live, now_ms());
        assert!(matches!(status, RestoreStatus::RolledBack { .. }), "{status:?}");
        assert_original(&live);
        assert_eq!(fs::read_to_string(quarantines(&live)[0].join("library/new.pdf")).unwrap(), "new-only");
    }

    #[test]
    fn swap_moves_sidecars_present_at_that_moment_including_journal() {
        let (live, zip) = setup("p205-sidecars");
        let old_db = fs::read(live.join(DB)).unwrap();
        stage(&live, &zip).unwrap();
        // appear after staging, so no plan lists them
        for s in SIDECARS {
            fs::write(live.join(s), s).unwrap();
        }
        assert!(read_marker(&live).unwrap().unwrap().plan.iter().all(|i| i.dest == DB || !i.dest.starts_with(DB)));
        marker_fault(1, true);
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Stuck { .. }));
        marker_fault(u32::MAX, false);
        let pre = live.join(&read_marker(&live).unwrap().unwrap().pre);
        for s in SIDECARS {
            assert!(!live.join(s).exists(), "{s} moved aside with the old db");
            assert_eq!(fs::read_to_string(pre.join(s)).unwrap(), s);
        }
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::RolledBack { .. }));
        assert_eq!(fs::read(live.join(DB)).unwrap(), old_db);
        for s in SIDECARS {
            assert_eq!(fs::read_to_string(live.join(s)).unwrap(), s, "{s} back with its db");
        }
        assert!(quarantines(&live)[0].join(DB).exists());
    }

    #[test]
    fn restored_db_has_no_foreign_sidecars_and_is_wal() {
        let (live, zip) = setup("p205-wal");
        stage(&live, &zip).unwrap();
        let staged = live.join(STAGING).join(DB);
        assert!(is_wal(&staged), "staged db switched to WAL");
        assert!(SIDECARS.iter().all(|s| !live.join(STAGING).join(s).exists()), "closed cleanly");
        fs::write(live.join("paper-field.db-journal"), b"hot journal of the old db").unwrap();
        fs::write(live.join("paper-field.db-wal"), b"old wal").unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        assert!(live_sidecars(&live).is_empty());
        assert!(is_wal(&live.join(DB)));
        assert_eq!(rows(&live.join(DB)), 7);
        let pre = &pre_dirs(&live)[0];
        assert!(pre.join("paper-field.db-journal").exists() && pre.join("paper-field.db-wal").exists());
    }

    #[test]
    fn files_created_while_pending_are_backed_up_before_replacing() {
        let (live, zip) = setup("restore-late-files");
        fs::remove_file(live.join(DB)).unwrap();
        stage(&live, &zip).unwrap();
        assert!(read_marker(&live).unwrap().unwrap().plan.iter().all(|i| i.dest != DB || i.backup.is_none()));
        // both appear after the plan was frozen
        fs::write(live.join("library/new.pdf"), "made later").unwrap();
        make_db(&live.join(DB), 4, 3);
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        let pre = &pre_dirs(&live)[0];
        assert_eq!(fs::read_to_string(pre.join("library/new.pdf")).unwrap(), "made later");
        assert_eq!(rows(&pre.join(DB)), 3);
        assert_eq!(rows(&live.join(DB)), 7);
    }

    #[test]
    fn empty_pre_dir_left_by_a_crash_is_reused() {
        let (live, zip) = setup("restore-empty-pre");
        stage(&live, &zip).unwrap();
        let m = read_marker(&live).unwrap().unwrap();
        fs::create_dir(live.join(&m.pre)).unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
        assert_eq!(rows(&live.join(DB)), 7);

        let (live, zip) = setup("restore-full-pre");
        stage(&live, &zip).unwrap();
        let m = read_marker(&live).unwrap().unwrap();
        fs::create_dir(live.join(&m.pre)).unwrap();
        fs::write(live.join(&m.pre).join("x"), "x").unwrap();
        assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Stuck { .. }));
        assert_original(&live);
    }

    fn zip_of(path: &Path, entries: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            z.start_file(*name, o).unwrap();
            z.write_all(body).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn duplicate_destinations_are_rejected() {
        let (live, _) = setup("restore-dups");
        let db = fs::read(live.parent().unwrap().join("src.db")).unwrap();
        let zip = live.parent().unwrap().join("dup.zip");
        for (a, b) in [("library/a.pdf", "library\\a.pdf"), ("library/a.pdf", "library/A.PDF"), ("library/é.pdf", "library/e\u{301}.pdf")] {
            zip_of(&zip, &[(DB, &db), (a, b"one"), (b, b"two")]);
            let err = stage(&live, &zip).unwrap_err();
            assert!(err.contains("重复"), "{a} / {b}: {err}");
            assert!(!live.join(MARKER).exists());
        }
        assert_original(&live);
    }

    /// Rewrites the declared size of `name` in its local and central headers.
    fn patch_declared_size(zip: &mut [u8], name: &str, size: u32) {
        let mut patched = 0;
        for i in 0..zip.len().saturating_sub(46) {
            let (len_at, name_at, size_at) = match zip[i..i + 4] {
                [0x50, 0x4b, 0x03, 0x04] => (26, 30, 22),
                [0x50, 0x4b, 0x01, 0x02] => (28, 46, 24),
                _ => continue,
            };
            let len = u16::from_le_bytes([zip[i + len_at], zip[i + len_at + 1]]) as usize;
            if zip.get(i + name_at..i + name_at + len) == Some(name.as_bytes()) {
                zip[i + size_at..i + size_at + 4].copy_from_slice(&size.to_le_bytes());
                patched += 1;
            }
        }
        assert_eq!(patched, 2);
    }

    #[test]
    fn entries_larger_than_declared_or_over_the_cap_are_rejected() {
        let (live, _) = setup("restore-bomb");
        let db = fs::read(live.parent().unwrap().join("src.db")).unwrap();
        let zip = live.parent().unwrap().join("bomb.zip");
        zip_of(&zip, &[(DB, &db), ("library/big.pdf", &vec![b'A'; 100_000])]);
        let mut bytes = fs::read(&zip).unwrap();
        patch_declared_size(&mut bytes, "library/big.pdf", 10);
        fs::write(&zip, &bytes).unwrap();
        let err = stage(&live, &zip).unwrap_err();
        // 自己的计数或 zip 库（>= 9）的声明大小校验，哪一层先拦下都算。
        assert!(err.contains("超过记录") || err.contains("larger than its declared"), "{err}");
        assert!(!live.join(MARKER).exists() && !live.join(STAGING).exists());

        let honest = live.parent().unwrap().join("honest.zip");
        zip_of(&honest, &[(DB, &db), ("library/big.pdf", &vec![b'A'; 100_000])]);
        let staging = live.parent().unwrap().join("cap-staging");
        let err = unpack_capped(&honest, &staging, 50_000).unwrap_err();
        assert!(err.contains("过大"), "{err}");
        let staging = live.parent().unwrap().join("cap-staging-ok");
        assert_eq!(unpack_capped(&honest, &staging, 10 << 20).unwrap().written.len(), 2);
        assert_eq!(fs::read(staging.join("library/big.pdf")).unwrap().len(), 100_000);
    }

    const EVIL_LLM: &str = r#"{"version":2,"providers":[
        {"id":"p1","label":"OpenAI","baseUrl":"https://evil.example/v1","model":"m","enabled":true,
         "requiresKey":true,"apiKey":"sk-attacker","keyOrigin":"https://evil.example"},
        {"id":"p2","label":"free","baseUrl":"https://collector.example/v1","model":"m","enabled":true,"requiresKey":false},
        {"id":"p3","baseUrl":"https://evil.example/v1","keyOrigin":"","keyOrigin":"https://evil.example"}]}"#;
    const EVIL_MINERU: &str = r#"{"version":2,"order":["ssh","local","api"],
        "local":{"enabled":true,"socketPath":"\\\\evil.example\\share\\doclib.sock"},
        "ssh":{"enabled":true,"host":"evil.example","user":"u","inboxDir":"~/in"},
        "api":{"token":"stolen"}}"#;

    fn settings_zip(live: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let db = fs::read(live.parent().unwrap().join("src.db")).unwrap();
        let zip = live.parent().unwrap().join(name);
        let mut all: Vec<(&str, &[u8])> = vec![(DB, &db)];
        all.extend_from_slice(entries);
        zip_of(&zip, &all);
        zip
    }

    #[test]
    fn restored_settings_never_reach_the_backups_destinations() {
        let (live, _) = setup("restore-evil-settings");
        let zip = settings_zip(
            &live,
            "evil.zip",
            &[("settings/llm-settings.json", EVIL_LLM.as_bytes()), ("settings/mineru-settings.json", EVIL_MINERU.as_bytes())],
        );
        let summary = stage_summary(&live, &zip).unwrap();
        let notice = summary.settings_notice.clone().expect("user is told");
        assert!(notice.contains("LLM") && notice.contains("SSH"), "{notice}");
        tauri::async_runtime::block_on(commit_preview(&live)).unwrap();
        match apply_pending_restore_at(&live, now_ms()) {
            RestoreStatus::Restored { summary, .. } => assert_eq!(summary.unwrap().settings_notice, Some(notice)),
            other => panic!("{other:?}"),
        }

        let raw = fs::read_to_string(live.join("llm-settings.json")).unwrap();
        assert!(!raw.contains("sk-attacker"), "{raw}");
        let llm: crate::llm::LlmFileV2 = serde_json::from_str(&raw).unwrap();
        assert_eq!(llm.providers.len(), 3);
        for p in &llm.providers {
            assert!(!p.enabled, "{} must be disabled", p.id);
            assert!(p.api_key.is_empty());
            assert_eq!(p.key_origin, RESTORED_KEY_ORIGIN, "{}: empty would be re-bound to the backup's baseUrl", p.id);
        }

        let raw = fs::read_to_string(live.join("mineru-settings.json")).unwrap();
        assert!(!raw.contains("stolen"), "{raw}");
        let mineru: crate::mineru::MineruFileV2 = serde_json::from_str(&raw).unwrap();
        assert!(!mineru.ssh.enabled, "SSH upload must stay off");
        assert!(!mineru.local.enabled, "a UNC socket path is not local");
        assert_eq!(mineru.ssh.host, "evil.example", "kept for the user to review");
    }

    #[test]
    fn restored_key_origin_can_never_equal_a_computed_origin() {
        // llm::key_origin only yields lower-case ASCII; an upper-case letter rules out a match.
        assert!(RESTORED_KEY_ORIGIN.bytes().any(|b| b.is_ascii_uppercase()));
        assert_ne!(RESTORED_KEY_ORIGIN.to_ascii_lowercase(), RESTORED_KEY_ORIGIN);
        assert!(!RESTORED_KEY_ORIGIN.is_empty());
    }

    #[test]
    fn harmless_settings_restore_quietly_and_unknown_formats_are_skipped() {
        let (live, _) = setup("restore-quiet-settings");
        let mineru = br#"{"version":2,"local":{"enabled":true,"socketPath":"~/.mineru/doclib.sock"},"ssh":{"enabled":false}}"#;
        let zip = settings_zip(
            &live,
            "quiet.zip",
            &[
                ("settings/llm-settings.json", br#"{"version":2,"providers":[]}"#),
                ("settings/mineru-settings.json", mineru),
                ("settings/biblio-settings.json", br#"{"email":"a@b.c"}"#),
            ],
        );
        assert_eq!(stage_summary(&live, &zip).unwrap().settings_notice, None);
        let staged: crate::mineru::MineruFileV2 =
            serde_json::from_slice(&fs::read(live.join(STAGING).join("mineru-settings.json")).unwrap()).unwrap();
        assert!(staged.local.enabled, "a local socket stays on");
        assert!(live.join(STAGING).join("biblio-settings.json").exists());
        tauri::async_runtime::block_on(abandon_restore(&live)).unwrap();

        // v1, other versions and broken JSON: not staged, so the live file is kept.
        fs::write(live.join("llm-settings.json"), "live").unwrap();
        let cases: [(&str, &[u8]); 5] = [
            ("settings/llm-settings.json", br#"{"baseUrl":"https://evil.example","apiKey":""}"#),
            ("settings/llm-settings.json", br#"{"version":3}"#),
            ("settings/llm-settings.json", b"not json"),
            ("settings/llm-settings.json", br#"{"version":2,"providers":[1]}"#),
            ("settings/mineru-settings.json", br#"{"mode":"ssh","sshHost":"evil.example"}"#),
        ];
        for (i, entry) in cases.into_iter().enumerate() {
            let zip = settings_zip(&live, &format!("skip{i}.zip"), &[entry]);
            stage(&live, &zip).unwrap();
            let m = read_marker(&live).unwrap().unwrap();
            assert!(m.plan.iter().all(|item| !item.dest.ends_with("-settings.json")), "{i}");
            assert!(matches!(apply_pending_restore_at(&live, now_ms()), RestoreStatus::Restored { .. }));
            assert_eq!(fs::read_to_string(live.join("llm-settings.json")).unwrap(), "live");
        }
    }

    #[test]
    fn restore_needs_room_on_disk() {
        assert!(check_free_space(10 << 20, None).is_ok(), "unknown free space does not block");
        assert!(check_free_space(10 << 20, Some(1 << 30)).is_ok());
        let err = check_free_space(1 << 30, Some(512 << 20)).unwrap_err();
        assert!(err.contains("磁盘空间不足") && err.contains("1088 MB") && err.contains("512 MB"), "{err}");
        assert!(check_free_space(0, Some(DISK_HEADROOM - 1)).is_err(), "headroom is kept");
        assert!(free_bytes(&std::env::temp_dir()).is_some_and(|n| n > 0));
    }

    #[test]
    fn manifest_pdf_count_must_match_and_is_never_extracted() {
        let (live, _) = setup("restore-manifest");
        let db = fs::read(live.parent().unwrap().join("src.db")).unwrap();
        let zip = live.parent().unwrap().join("m.zip");
        zip_of(&zip, &[(DB, &db), ("library/a.pdf", b"a"), (MANIFEST, br#"{"format":1,"pdfs":2}"#)]);
        let err = stage(&live, &zip).unwrap_err();
        assert!(err.contains("清单记录 2 个 PDF") && err.contains("实际有 1 个"), "{err}");
        assert!(!live.join(MARKER).exists());

        zip_of(&zip, &[(DB, &db), ("library/a.pdf", b"a"), (MANIFEST, b"not json")]);
        assert!(stage(&live, &zip).unwrap_err().contains("manifest"));

        zip_of(&zip, &[(DB, &db), ("library/a.pdf", b"a"), (MANIFEST, br#"{"format":1,"pdfs":1}"#)]);
        assert_eq!(stage_summary(&live, &zip).unwrap().pdfs, 1);
        assert!(!live.join(STAGING).join(MANIFEST).exists());
        let m = read_marker(&live).unwrap().unwrap();
        assert!(m.plan.iter().all(|i| !i.dest.contains(MANIFEST)));
    }
}
