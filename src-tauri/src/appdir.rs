//! One-time copy of the previous bundle identifier's app support directory.
//!
//! `com.paperfield.app` ends in `.app`, which macOS treats as an application
//! bundle. The identifier is now `com.paperfield.notes`, so Tauri's config and
//! data directories move with it. This runs before `tauri-plugin-sql` opens
//! `paper-field.db`: if the new directory is missing or empty and the old one
//! exists, its contents are copied (never moved, never over an existing file).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

pub const OLD_IDENTIFIER: &str = "com.paperfield.app";
pub const NEW_IDENTIFIER: &str = "com.paperfield.notes";
pub const MARKER_NAME: &str = ".migrated-from-com.paperfield.app";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostOs {
    Macos,
    Windows,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportKind {
    Config,
    Data,
    Local,
}

#[derive(Clone, Debug)]
pub struct SupportEnv {
    pub home: PathBuf,
    pub appdata: Option<PathBuf>,
    pub local_appdata: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub xdg_data_home: Option<PathBuf>,
}

impl SupportEnv {
    pub fn from_process(home: PathBuf) -> Self {
        Self {
            home,
            appdata: env_path("APPDATA"),
            local_appdata: env_path("LOCALAPPDATA"),
            xdg_config_home: env_path("XDG_CONFIG_HOME"),
            xdg_data_home: env_path("XDG_DATA_HOME"),
        }
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn current_os() -> HostOs {
    if cfg!(target_os = "macos") {
        HostOs::Macos
    } else if cfg!(target_os = "windows") {
        HostOs::Windows
    } else {
        HostOs::Linux
    }
}

/// Platform app-support directory for an identifier.
///
/// - macOS: `~/Library/Application Support/<id>` (config, data, and local)
/// - Windows: `%APPDATA%/<id>` (config and data), `%LOCALAPPDATA%/<id>` (local)
/// - Linux: `$XDG_CONFIG_HOME/<id>` or `~/.config/<id>` (config);
///   `$XDG_DATA_HOME/<id>` or `~/.local/share/<id>` (data and local)
pub fn support_dir(os: HostOs, env: &SupportEnv, identifier: &str, kind: SupportKind) -> PathBuf {
    let root = match (os, kind) {
        (HostOs::Macos, _) => env.home.join("Library").join("Application Support"),
        (HostOs::Windows, SupportKind::Local) => env
            .local_appdata
            .clone()
            .unwrap_or_else(|| env.home.join("AppData").join("Local")),
        (HostOs::Windows, _) => env
            .appdata
            .clone()
            .unwrap_or_else(|| env.home.join("AppData").join("Roaming")),
        (HostOs::Linux, SupportKind::Config) => env
            .xdg_config_home
            .clone()
            .unwrap_or_else(|| env.home.join(".config")),
        (HostOs::Linux, _) => env
            .xdg_data_home
            .clone()
            .unwrap_or_else(|| env.home.join(".local").join("share")),
    };
    root.join(identifier)
}

pub fn legacy_sibling(new_dir: &Path) -> PathBuf {
    new_dir
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(OLD_IDENTIFIER)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationStatus {
    Copied { files: u64 },
    AlreadyMigrated,
    AlreadyHasData,
    NoSource,
}

/// Copy `old_dir` into `new_dir` once.
///
/// A new directory that already contains anything other than the marker is
/// left untouched, including files that exist only in the old directory.
/// The marker makes a successful copy one-time: emptying the new directory
/// later does not copy again. The old directory is never removed.
pub fn migrate_dir(old_dir: &Path, new_dir: &Path) -> Result<MigrationStatus, String> {
    if old_dir == new_dir {
        return Ok(MigrationStatus::NoSource);
    }
    if marker_exists(new_dir)? {
        return Ok(MigrationStatus::AlreadyMigrated);
    }
    if dir_has_user_data(new_dir)? {
        return Ok(MigrationStatus::AlreadyHasData);
    }
    if !old_dir.is_dir() || dir_entries(old_dir)?.is_empty() {
        return Ok(MigrationStatus::NoSource);
    }

    let staging = staging_path(new_dir);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|err| format!("清理未完成的迁移目录失败：{err}"))?;
    }
    let files = copy_tree(old_dir, &staging).map_err(|err| {
        let _ = fs::remove_dir_all(&staging);
        err
    })?;
    write_marker(&staging, old_dir, files)?;

    if new_dir.exists() {
        if dir_has_user_data(new_dir)? || marker_exists(new_dir)? {
            let _ = fs::remove_dir_all(&staging);
            return Ok(if marker_exists(new_dir).unwrap_or(false) {
                MigrationStatus::AlreadyMigrated
            } else {
                MigrationStatus::AlreadyHasData
            });
        }
        fs::remove_dir_all(new_dir).map_err(|err| format!("替换空的新目录失败：{err}"))?;
    }
    if let Some(parent) = new_dir.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建应用目录失败：{err}"))?;
    }
    fs::rename(&staging, new_dir).map_err(|err| {
        format!(
            "将迁移结果放到 {} 失败：{err}",
            new_dir.display()
        )
    })?;
    Ok(MigrationStatus::Copied { files })
}

fn marker_exists(dir: &Path) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(false);
    }
    if !dir.is_dir() {
        return Err(format!("{} 已存在但不是目录，已跳过以免覆盖", dir.display()));
    }
    Ok(dir.join(MARKER_NAME).is_file())
}

fn dir_has_user_data(dir: &Path) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(false);
    }
    Ok(dir_entries(dir)?
        .into_iter()
        .any(|name| name != MARKER_NAME))
}

fn dir_entries(dir: &Path) -> Result<Vec<std::ffi::OsString>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| format!("读取 {} 失败：{err}", dir.display()))? {
        let entry = entry.map_err(|err| err.to_string())?;
        names.push(entry.file_name());
    }
    Ok(names)
}

fn staging_path(new_dir: &Path) -> PathBuf {
    let mut name = new_dir.file_name().unwrap_or_default().to_os_string();
    name.push(".migrating");
    match new_dir.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

fn write_marker(dir: &Path, from: &Path, files: u64) -> Result<(), String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let body = format!(
        "copied_from={}\nfiles={files}\nunix_secs={secs}\nnote=copied, not moved; existing files in the new directory were not overwritten\n",
        from.display()
    );
    fs::write(dir.join(MARKER_NAME), body).map_err(|err| format!("写入迁移标记失败：{err}"))
}

fn copy_tree(src: &Path, dest: &Path) -> Result<u64, String> {
    let meta = fs::symlink_metadata(src).map_err(|err| format!("{}：{err}", src.display()))?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(src).map_err(|err| err.to_string())?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        symlink_at(&target, dest)?;
        return Ok(1);
    }
    if meta.is_dir() {
        fs::create_dir_all(dest).map_err(|err| err.to_string())?;
        let mut count = 0;
        for entry in fs::read_dir(src).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            if entry.file_name() == MARKER_NAME {
                continue;
            }
            count += copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(count);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::copy(src, dest).map_err(|err| format!("复制 {} 失败：{err}", src.display()))?;
    Ok(1)
}

fn symlink_at(target: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, dest).map_err(|err| err.to_string())
    }
    #[cfg(not(unix))]
    {
        if target.is_file() {
            fs::copy(target, dest).map(|_| ()).map_err(|err| err.to_string())
        } else {
            Err(format!("无法复制符号链接 {}", dest.display()))
        }
    }
}

pub fn migration_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("appdir-migrate")
        .setup(|app, _api| {
            migrate_on_startup(app);
            Ok(())
        })
        .build()
}

pub fn migrate_on_startup<R: Runtime>(app: &AppHandle<R>) {
    // These are the directories tauri-plugin-sql and the settings files use
    // (`app_config_dir` is `config_dir/<identifier>`). The formula below covers
    // the same locations if path resolution is unavailable during plugin setup.
    let mut targets = Vec::new();
    for (label, path) in [
        ("config", app.path().app_config_dir()),
        ("data", app.path().app_data_dir()),
        ("local", app.path().app_local_data_dir()),
    ] {
        match path {
            Ok(path) => targets.push(path),
            Err(err) => eprintln!("[paper-field] 无法解析应用{label}目录：{err}"),
        }
    }
    if let Ok(home) = app.path().home_dir() {
        let env = SupportEnv::from_process(home);
        for kind in [SupportKind::Config, SupportKind::Data, SupportKind::Local] {
            targets.push(support_dir(current_os(), &env, NEW_IDENTIFIER, kind));
        }
    }
    apply_migrations(&targets);
}

fn apply_migrations(new_dirs: &[PathBuf]) {
    let mut seen = HashSet::new();
    for new_dir in new_dirs {
        let key = new_dir.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        let old_dir = legacy_sibling(new_dir);
        match migrate_dir(&old_dir, new_dir) {
            Ok(MigrationStatus::Copied { files }) => {
                eprintln!(
                    "[paper-field] 已将应用数据从 {} 复制到 {}（{files} 个文件）。旧目录保留，未移动，也未覆盖新目录里已有的文件。标记：{MARKER_NAME}",
                    old_dir.display(),
                    new_dir.display()
                );
            }
            Ok(_) => {}
            Err(err) => eprintln!(
                "[paper-field] 应用数据目录迁移失败（{} → {}）：{err}",
                old_dir.display(),
                new_dir.display()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pf-appdir-{nanos}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identifier_matches_tauri_conf_and_does_not_end_in_app() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_IDENTIFIER);
        assert!(!NEW_IDENTIFIER.ends_with(".app"));
        assert!(OLD_IDENTIFIER.ends_with(".app"));
    }

    #[test]
    fn support_dirs_follow_each_platform() {
        let home = PathBuf::from("/home/reader");
        let env = SupportEnv {
            home: home.clone(),
            appdata: Some(PathBuf::from("C:/Users/reader/AppData/Roaming")),
            local_appdata: Some(PathBuf::from("C:/Users/reader/AppData/Local")),
            xdg_config_home: Some(PathBuf::from("/xdg/config")),
            xdg_data_home: Some(PathBuf::from("/xdg/data")),
        };
        assert_eq!(
            support_dir(HostOs::Macos, &env, OLD_IDENTIFIER, SupportKind::Config),
            home.join("Library/Application Support").join(OLD_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Macos, &env, NEW_IDENTIFIER, SupportKind::Data),
            home.join("Library/Application Support").join(NEW_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Windows, &env, OLD_IDENTIFIER, SupportKind::Config),
            PathBuf::from("C:/Users/reader/AppData/Roaming").join(OLD_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Windows, &env, OLD_IDENTIFIER, SupportKind::Local),
            PathBuf::from("C:/Users/reader/AppData/Local").join(OLD_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Linux, &env, OLD_IDENTIFIER, SupportKind::Config),
            PathBuf::from("/xdg/config").join(OLD_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Linux, &env, OLD_IDENTIFIER, SupportKind::Data),
            PathBuf::from("/xdg/data").join(OLD_IDENTIFIER)
        );
    }

    #[test]
    fn support_dirs_use_home_defaults_when_env_is_unset() {
        let env = SupportEnv {
            home: PathBuf::from("/Users/reader"),
            appdata: None,
            local_appdata: None,
            xdg_config_home: None,
            xdg_data_home: None,
        };
        assert_eq!(
            support_dir(HostOs::Windows, &env, NEW_IDENTIFIER, SupportKind::Config),
            PathBuf::from("/Users/reader/AppData/Roaming").join(NEW_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Linux, &env, NEW_IDENTIFIER, SupportKind::Config),
            PathBuf::from("/Users/reader/.config").join(NEW_IDENTIFIER)
        );
        assert_eq!(
            support_dir(HostOs::Linux, &env, NEW_IDENTIFIER, SupportKind::Local),
            PathBuf::from("/Users/reader/.local/share").join(NEW_IDENTIFIER)
        );
    }

    #[test]
    fn copies_when_new_dir_is_missing_and_leaves_the_old_dir() {
        let root = scratch();
        let old = root.join(OLD_IDENTIFIER);
        let new_dir = root.join(NEW_IDENTIFIER);
        fs::create_dir_all(old.join("library")).unwrap();
        fs::write(old.join("paper-field.db"), b"old-db").unwrap();
        fs::write(old.join("library").join("a.pdf"), b"pdf").unwrap();

        let status = migrate_dir(&old, &new_dir).unwrap();
        assert_eq!(status, MigrationStatus::Copied { files: 2 });
        assert_eq!(fs::read(old.join("paper-field.db")).unwrap(), b"old-db");
        assert_eq!(fs::read(new_dir.join("paper-field.db")).unwrap(), b"old-db");
        assert_eq!(fs::read(new_dir.join("library").join("a.pdf")).unwrap(), b"pdf");
        assert!(new_dir.join(MARKER_NAME).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_not_overwrite_a_new_dir_that_already_has_data() {
        let root = scratch();
        let old = root.join("old");
        let new_dir = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(old.join("paper-field.db"), b"old-db").unwrap();
        fs::write(old.join("llm-settings.json"), b"old-settings").unwrap();
        fs::write(new_dir.join("paper-field.db"), b"new-db").unwrap();

        assert_eq!(
            migrate_dir(&old, &new_dir).unwrap(),
            MigrationStatus::AlreadyHasData
        );
        assert_eq!(fs::read(new_dir.join("paper-field.db")).unwrap(), b"new-db");
        assert!(!new_dir.join("llm-settings.json").exists());
        assert!(!new_dir.join(MARKER_NAME).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn marker_makes_the_copy_one_time() {
        let root = scratch();
        let old = root.join("old");
        let new_dir = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("paper-field.db"), b"v1").unwrap();
        assert!(matches!(
            migrate_dir(&old, &new_dir).unwrap(),
            MigrationStatus::Copied { .. }
        ));
        fs::write(old.join("later.txt"), b"nope").unwrap();
        fs::remove_file(new_dir.join("paper-field.db")).unwrap();
        assert_eq!(
            migrate_dir(&old, &new_dir).unwrap(),
            MigrationStatus::AlreadyMigrated
        );
        assert!(!new_dir.join("later.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_new_directory_still_receives_the_copy() {
        let root = scratch();
        let old = root.join("old");
        let new_dir = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(old.join("mineru-settings.json"), b"{}").unwrap();
        assert_eq!(
            migrate_dir(&old, &new_dir).unwrap(),
            MigrationStatus::Copied { files: 1 }
        );
        assert_eq!(fs::read(new_dir.join("mineru-settings.json")).unwrap(), b"{}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_old_directory_does_nothing() {
        let root = scratch();
        let status = migrate_dir(&root.join("missing"), &root.join("new")).unwrap();
        assert_eq!(status, MigrationStatus::NoSource);
        assert!(!root.join("new").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
