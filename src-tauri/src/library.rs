//! 文库 PDF 的存储路径。
//!
//! 数据库里只存文库内的相对名 `library/<文件名>`，用到时再拼到当前的应用数据目录上：
//! 换机恢复备份、旧目录 `com.paperfield.app` 被删、数据目录整体搬家之后，链接都还有效。
//! 文库外的 PDF（旧数据）仍是绝对路径，按原样使用。

#![deny(clippy::string_slice)]

use std::path::{Path, PathBuf};

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

/// 把数据库里的 PDF 路径解析成本机路径：文库相对名拼到应用数据目录，绝对路径原样返回。
pub fn resolve(config_dir: &Path, stored: &str) -> PathBuf {
    match library_file_name(stored.trim()) {
        Some(name) => config_dir.join(LIBRARY_DIR).join(name),
        None => PathBuf::from(stored),
    }
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
pub fn relativize_database(config_dir: &Path) -> Result<u64, String> {
    let db = config_dir.join(crate::db::DB_FILE);
    if !db.is_file() {
        return Ok(0);
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
                return Ok(0);
            }
            let rows = sqlx::query(
                "SELECT id, pdf_path FROM papers WHERE pdf_path IS NOT NULL AND pdf_path != '' AND pdf_path NOT LIKE 'library/%'",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
            let mut changed = 0u64;
            for row in rows {
                let id: String = row.get(0);
                let path: String = row.get(1);
                if let Some(next) = relativize(config_dir, &path) {
                    changed += sqlx::query("UPDATE papers SET pdf_path = ? WHERE id = ? AND pdf_path = ?")
                        .bind(&next)
                        .bind(&id)
                        .bind(&path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?
                        .rows_affected();
                }
            }
            Ok(changed)
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
        assert_eq!(resolve(&config, "library/a.pdf"), config.join("library").join("a.pdf"));
        assert_eq!(resolve(&config, "library\\a.pdf"), config.join("library").join("a.pdf"));
        assert_eq!(resolve(&config, "/elsewhere/a.pdf"), PathBuf::from("/elsewhere/a.pdf"));
        // 越界写法不当作文库内文件
        assert_eq!(resolve(&config, "library/../secret.pdf"), PathBuf::from("library/../secret.pdf"));
        assert_eq!(resolve(&config, "library/sub/a.pdf"), PathBuf::from("library/sub/a.pdf"));
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
}
