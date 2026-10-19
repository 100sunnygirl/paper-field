//! 文库 PDF 的存储路径。
//!
//! 数据库里只存文库内的相对名 `library/<文件名>`，用到时再拼到当前的应用数据目录上：
//! 换机恢复备份、旧目录 `com.paperfield.app` 被删、数据目录整体搬家之后，链接都还有效。
//! 文库外的 PDF（旧数据）仍是绝对路径；只有升级时已在库里的那些（见 LEGACY_FILE）才放行。

#![deny(clippy::string_slice)]

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub const LIBRARY_DIR: &str = "library";

/// 文库内文件在数据库里的写法。
pub fn stored_name(file_name: &str) -> String {
    format!("{LIBRARY_DIR}/{file_name}")
}

/// `library/<name>` 中的 name；不是这种写法（或含路径分隔、`..`）时返回 None。
fn library_file_name(stored: &str) -> Option<&str> {
    let rest = stored
        .strip_prefix("library/")
        .or_else(|| stored.strip_prefix("library\\"))?;
    let valid = !rest.is_empty()
        && rest != "."
        && rest != ".."
        && !rest.contains('/')
        && !rest.contains('\\')
        && !rest.contains('\0');
    valid.then_some(rest)
}

/// 网络共享 / 设备 / verbatim 路径：`\\server\share`、`//server/share`、`\\?\`、`\\.\`、`\??\`。
/// 所有平台一律拒绝：Windows 上一碰（is_file / 打开）就会向对方 SMB 服务器认证，泄露 NTLM 哈希；
/// 恢复来的数据库里可能就写着这种路径。
pub fn is_remote_or_device_path(raw: &str) -> bool {
    let s = raw.trim_start();
    let mut chars = s.chars();
    let sep = |c: Option<char>| matches!(c, Some('\\' | '/'));
    let (first, second) = (chars.next(), chars.next());
    (sep(first) && sep(second)) || s.starts_with("\\??\\") || s.starts_with("/??/")
}

/// 本次运行里用户在系统对话框中选中的 PDF（含所选文件夹里列出的），由 Rust 侧记录。
/// 接受外部路径的命令只认这里的条目：渲染进程被注入脚本时也拿不到任意文件。
#[derive(Default)]
pub struct PdfGrants(Mutex<HashSet<PathBuf>>);

impl PdfGrants {
    pub fn grant(&self, path: PathBuf) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(path);
    }

    fn contains(&self, path: &Path) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).contains(path)
    }
}

const UNAUTHORIZED_PDF: &str = "无法访问这个 PDF：请通过「添加论文」重新选择该文件";

/// 把渲染进程（或数据库）给出的 PDF 路径解析成本机路径——文库相对名拼到当前应用数据目录——
/// 并判断能否碰：只放行
/// 1) 本次运行系统对话框选中的文件；2) 文库里的文件（`library/<name>` 或文库目录下的绝对路径）；
/// 3) 升级到本版本时数据库里已有的文库外旧路径（见 [`LEGACY_FILE`]）。
/// 网络共享 / 设备路径在碰文件系统之前就拒绝（对话框选中的除外：那是用户自己选的）。
/// 授权判断只看字符串，不访问文件系统，免得被当成「文件是否存在」的探针。
pub fn authorize_pdf(config_dir: &Path, grants: &PdfGrants, stored: &str) -> Result<PathBuf, String> {
    let stored = stored.trim();
    if stored.is_empty() || stored.contains('\0') {
        return Err("PDF 路径无效".into());
    }
    if grants.contains(Path::new(stored)) {
        return Ok(PathBuf::from(stored));
    }
    if is_remote_or_device_path(stored) {
        return Err("不支持网络共享或设备路径上的 PDF，请先复制到本机".into());
    }
    let library = config_dir.join(LIBRARY_DIR);
    if let Some(name) = library_file_name(stored) {
        return Ok(library.join(name));
    }
    let path = Path::new(stored);
    let plain = path.components().all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    if plain && path.is_absolute() && path.parent() == Some(library.as_path()) {
        return Ok(path.to_path_buf());
    }
    if legacy_contains(config_dir, stored) {
        return Ok(path.to_path_buf());
    }
    Err(UNAUTHORIZED_PDF.into())
}

/// 文库外旧路径的快照：首次以本版本启动时从数据库抄一次，之后只读不增。
/// 渲染进程能改数据库但写不了这个文件，所以注入脚本塞进 `pdf_path` 的路径重启后也不会被放行。
pub const LEGACY_FILE: &str = "legacy-pdf-paths.json";

/// 按数据目录分开存（正式运行只有一个；测试里多个临时目录并行）。
static LEGACY: Mutex<Vec<(PathBuf, HashSet<String>)>> = Mutex::new(Vec::new());

fn legacy_contains(config_dir: &Path, stored: &str) -> bool {
    let guard = LEGACY.lock().unwrap_or_else(|e| e.into_inner());
    guard.iter().any(|(dir, set)| dir == config_dir && set.contains(stored))
}

/// 读取（不存在时用 `current` 建立）旧路径快照并装入内存。网络共享 / 设备路径不进快照。
fn load_legacy_snapshot(config_dir: &Path, current: impl FnOnce() -> Result<Vec<String>, String>) -> Result<(), String> {
    let file = config_dir.join(LEGACY_FILE);
    let paths: Vec<String> = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{LEGACY_FILE} 无法解析：{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let paths: Vec<String> = current()?
                .into_iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty() && library_file_name(p).is_none() && !is_remote_or_device_path(p))
                .collect();
            let bytes = serde_json::to_vec_pretty(&paths).map_err(|e| e.to_string())?;
            crate::io_util::atomic_write(&file, &bytes)?;
            paths
        }
        Err(e) => return Err(format!("{LEGACY_FILE} 无法读取：{e}")),
    };
    let set = paths.into_iter().filter(|p| !is_remote_or_device_path(p)).collect();
    let mut guard = LEGACY.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|(dir, _)| dir != config_dir);
    guard.push((config_dir.to_path_buf(), set));
    Ok(())
}

/// 旧的绝对路径若指向某个 Paper Field 数据目录下的 `library/<name>`，且当前文库里确有这个文件，
/// 返回应改写成的相对名。两种分隔符都认：Windows 上的备份可以在 macOS 恢复，反之亦然。
pub fn relativize(config_dir: &Path, stored: &str) -> Option<String> {
    if library_file_name(stored).is_some() {
        return None;
    }
    let parts: Vec<&str> = stored.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
    let [.., app_dir, library, name] = parts.as_slice() else { return None };
    if *library != LIBRARY_DIR || !matches!(*app_dir, "com.paperfield.app" | "com.paperfield.notes") {
        return None;
    }
    library_file_name(&stored_name(name))?;
    config_dir.join(LIBRARY_DIR).join(name).is_file().then(|| stored_name(name))
}

/// 启动时（恢复与目录迁移之后、数据库层打开之前）把能改写的旧绝对路径改成文库相对名。
/// 幂等：每次启动都可以跑，换机恢复的备份也在这里被修正。返回改写的行数。
/// 顺带装入文库外旧路径的快照（首次运行时从改写后的数据库建立，见 [`LEGACY_FILE`]）。
pub fn relativize_database(config_dir: &Path) -> Result<u64, String> {
    let (changed, remaining) = relativize_rows(config_dir)?;
    load_legacy_snapshot(config_dir, || Ok(remaining))?;
    Ok(changed)
}

fn relativize_rows(config_dir: &Path) -> Result<(u64, Vec<String>), String> {
    let db = config_dir.join(crate::db::DB_FILE);
    if !db.is_file() {
        return Ok((0, Vec::new()));
    }
    tauri::async_runtime::block_on(async {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use sqlx::Row;
        let options = SqliteConnectOptions::new().filename(&db).create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|e| e.to_string())?;
        let result = async {
            let has_papers: i64 = sqlx::query(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'papers'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?
            .get(0);
            if has_papers == 0 {
                return Ok((0, Vec::new()));
            }
            let rows = sqlx::query(
                "SELECT id, pdf_path FROM papers WHERE pdf_path IS NOT NULL AND pdf_path != '' AND pdf_path NOT LIKE 'library/%'",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
            let mut changed = 0u64;
            let mut remaining = Vec::new();
            for row in rows {
                let id: String = row.get(0);
                let path: String = row.get(1);
                match relativize(config_dir, &path) {
                    Some(next) => {
                        changed += sqlx::query("UPDATE papers SET pdf_path = ? WHERE id = ? AND pdf_path = ?")
                            .bind(&next)
                            .bind(&id)
                            .bind(&path)
                            .execute(&pool)
                            .await
                            .map_err(|e| e.to_string())?
                            .rows_affected();
                    }
                    None => remaining.push(path),
                }
            }
            Ok((changed, remaining))
        }
        .await;
        pool.close().await;
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        let dir = crate::test_util::unique_temp_dir(&format!("pf-library-{name}"));
        fs::create_dir_all(dir.join(LIBRARY_DIR)).unwrap();
        dir
    }

    #[test]
    fn resolves_library_names_against_the_current_dir() {
        let config = dir("resolve");
        let resolve = |stored: &str| authorize_pdf(&config, &PdfGrants::default(), stored);
        assert_eq!(resolve("library/a.pdf").unwrap(), config.join("library").join("a.pdf"));
        assert_eq!(resolve("library\\a.pdf").unwrap(), config.join("library").join("a.pdf"));
        assert_eq!(resolve(" library/a.pdf ").unwrap(), config.join("library").join("a.pdf"));
        // 文库外的绝对路径与越界写法都不当作文库内文件
        assert!(resolve("/elsewhere/a.pdf").is_err());
        assert!(resolve("library/../secret.pdf").is_err());
        assert!(resolve("library/sub/a.pdf").is_err());
    }

    #[test]
    fn relativizes_old_paths_from_either_identifier_and_os() {
        let config = dir("relativize");
        fs::write(config.join("library").join("1700-a.pdf"), b"%PDF").unwrap();
        for old in [
            "/Users/alice/Library/Application Support/com.paperfield.app/library/1700-a.pdf",
            "/Users/bob/Library/Application Support/com.paperfield.notes/library/1700-a.pdf",
            "C:\\Users\\x\\AppData\\Roaming\\com.paperfield.notes\\library\\1700-a.pdf",
        ] {
            assert_eq!(relativize(&config, old).as_deref(), Some("library/1700-a.pdf"), "{old}");
        }
        // 文件不在当前文库 / 不是 Paper Field 的文库 / 已经是相对名：不改
        assert_eq!(relativize(&config, "/x/com.paperfield.notes/library/missing.pdf"), None);
        assert_eq!(relativize(&config, "/Users/alice/Papers/library/1700-a.pdf"), None);
        assert_eq!(relativize(&config, "library/1700-a.pdf"), None);
    }

    #[test]
    fn rewrites_database_rows_in_place_and_is_idempotent() {
        let config = dir("db");
        fs::write(config.join("library").join("p.pdf"), b"%PDF").unwrap();
        let db = config.join(crate::db::DB_FILE);
        tauri::async_runtime::block_on(async {
            use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(SqliteConnectOptions::new().filename(&db).create_if_missing(true))
                .await
                .unwrap();
            sqlx::query("CREATE TABLE papers (id TEXT PRIMARY KEY, pdf_path TEXT)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO papers VALUES ('a', '/old/com.paperfield.app/library/p.pdf'), ('b', '/home/u/outside.pdf'), ('c', NULL)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });
        assert_eq!(relativize_database(&config).unwrap(), 1);
        assert_eq!(relativize_database(&config).unwrap(), 0);
    }

    #[test]
    fn remote_and_device_paths_are_detected_on_every_platform() {
        for bad in [
            r"\\attacker\share\x.pdf",
            "//attacker/share/x.pdf",
            r"\\?\C:\x.pdf",
            r"\\?\UNC\attacker\share\x.pdf",
            r"\\.\PhysicalDrive0",
            r"\??\C:\x.pdf",
            r"/\attacker\share",
            "  \\\\attacker\\share",
        ] {
            assert!(is_remote_or_device_path(bad), "{bad}");
        }
        for ok in ["/Users/a/x.pdf", r"C:\Users\a\x.pdf", "library/a.pdf", r"\Users\a.pdf", ""] {
            assert!(!is_remote_or_device_path(ok), "{ok}");
        }
    }

    #[test]
    fn authorize_accepts_only_picked_library_or_legacy_paths() {
        let config = dir("authorize");
        let grants = PdfGrants::default();
        let library = config.join(LIBRARY_DIR);
        // 文库内：相对名与文库目录下的绝对路径
        assert_eq!(authorize_pdf(&config, &grants, "library/a.pdf").unwrap(), library.join("a.pdf"));
        let inside = library.join("b.pdf");
        assert_eq!(authorize_pdf(&config, &grants, &inside.to_string_lossy()).unwrap(), inside);
        // 越界与任意绝对路径：拒绝
        for bad in ["library/../x.pdf", "/etc/x.pdf", "relative.pdf", "", "a\0b"] {
            assert!(authorize_pdf(&config, &grants, bad).is_err(), "{bad}");
        }
        let escape = format!("{}/../../x.pdf", library.display());
        assert!(authorize_pdf(&config, &grants, &escape).is_err());
        // 网络共享：即使出现在旧路径快照里也不放行
        let unc = r"\\attacker\share\x.pdf";
        load_legacy_snapshot(&config, || Ok(vec![unc.into(), "/old/papers/x.pdf".into()])).unwrap();
        assert!(authorize_pdf(&config, &grants, unc).unwrap_err().contains("网络共享"));
        assert_eq!(authorize_pdf(&config, &grants, "/old/papers/x.pdf").unwrap(), PathBuf::from("/old/papers/x.pdf"));
        // 对话框选中的路径：原样放行（用户自己选的网络共享也可以）
        let picked = config.join("picked.pdf");
        assert!(authorize_pdf(&config, &grants, &picked.to_string_lossy()).is_err());
        grants.grant(picked.clone());
        grants.grant(PathBuf::from(unc));
        assert_eq!(authorize_pdf(&config, &grants, &picked.to_string_lossy()).unwrap(), picked);
        assert_eq!(authorize_pdf(&config, &grants, unc).unwrap(), PathBuf::from(unc));
    }

    #[test]
    fn legacy_snapshot_is_taken_once_and_never_extended() {
        let config = dir("legacy");
        let db = config.join(crate::db::DB_FILE);
        let run = |sql: &'static str| {
            tauri::async_runtime::block_on(async {
                use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
                let pool = SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect_with(SqliteConnectOptions::new().filename(&db).create_if_missing(true))
                    .await
                    .unwrap();
                sqlx::query(sql).execute(&pool).await.unwrap();
                pool.close().await;
            })
        };
        run("CREATE TABLE papers (id TEXT PRIMARY KEY, pdf_path TEXT)");
        run(r"INSERT INTO papers VALUES ('a', '/home/u/old.pdf'), ('b', '\\evil\s\x.pdf'), ('c', 'library/x.pdf')");
        relativize_database(&config).unwrap();
        let saved: Vec<String> = serde_json::from_slice(&fs::read(config.join(LEGACY_FILE)).unwrap()).unwrap();
        assert_eq!(saved, vec!["/home/u/old.pdf".to_string()]);
        let grants = PdfGrants::default();
        assert!(authorize_pdf(&config, &grants, "/home/u/old.pdf").is_ok());
        // 渲染进程后来写进数据库的路径：重启后也不进快照
        run("INSERT INTO papers VALUES ('d', '/home/u/secret.pdf')");
        relativize_database(&config).unwrap();
        assert!(authorize_pdf(&config, &grants, "/home/u/secret.pdf").is_err());
        assert!(authorize_pdf(&config, &grants, "/home/u/old.pdf").is_ok());
    }
}
