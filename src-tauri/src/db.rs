//! 文库数据库的唯一访问通道。
//!
//! 渲染进程不再直连 SQLite：读走只读授权的连接池，写走单连接写池，
//! 批量写在一个事务里执行，任一步受影响行数不符合期望就整体回滚。
//! 每条语句先在本连接上预编译检查：只允许单条语句，拒绝 ATTACH / DETACH /
//! VACUUM 与白名单外的 PRAGMA，读连接只接受只读语句。即使页面被注入脚本，
//! 也无法借 SQL 在磁盘上写出任意文件。

use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::Duration;

use libsqlite3_sys as ffi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::{Column, Decode, Row, Sqlite, TypeInfo, ValueRef};
use tauri::{AppHandle, State};

pub const DB_FILE: &str = "paper-field.db";

#[derive(Clone)]
struct Pools {
    reader: SqlitePool,
    writer: SqlitePool,
}

#[derive(Default)]
pub struct Db {
    pools: tokio::sync::Mutex<Option<Pools>>,
}

impl Db {
    async fn pools(&self, app: &AppHandle) -> Result<Pools, DbError> {
        let mut guard = self.pools.lock().await;
        if let Some(pools) = guard.as_ref() {
            return Ok(pools.clone());
        }
        if matches!(crate::restore::restore_status(), crate::restore::RestoreStatus::Stuck { .. }) {
            return Err(DbError::sql("上一次恢复没有完成，为保护数据暂不打开文库"));
        }
        let path = crate::app_config_dir(app).map_err(DbError::sql)?.join(DB_FILE);
        let pools = open_pools(&path).await?;
        *guard = Some(pools.clone());
        Ok(pools)
    }

    /// 关闭两个连接池：最后一个连接关闭时 SQLite 会做检查点并删掉 -wal。
    pub async fn close(&self) {
        if let Some(pools) = self.pools.lock().await.take() {
            pools.writer.close().await;
            pools.reader.close().await;
        }
    }
}

/// `expect`：一步的受影响行数必须满足的条件。
#[derive(Deserialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Expect {
    /// 恰好 1 行
    One,
    /// 至少 1 行
    Some,
    /// 不检查
    #[default]
    Any,
}

impl Expect {
    fn accepts(self, rows: u64) -> bool {
        match self {
            Expect::One => rows == 1,
            Expect::Some => rows >= 1,
            Expect::Any => true,
        }
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct Step {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub expect: Expect,
}

/// 前端据 `kind` 区分「前提被改了」（conflict）与真正的 SQL 错误。
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbError {
    Conflict { step: usize },
    Sql { message: String },
}

impl DbError {
    fn sql(message: impl Into<String>) -> Self {
        DbError::Sql { message: message.into() }
    }
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        DbError::sql(err.to_string())
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Conflict { step } => write!(f, "写入冲突（第 {} 步）", step + 1),
            DbError::Sql { message } => f.write_str(message),
        }
    }
}

fn base_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true)
}

async fn open_pools(path: &Path) -> Result<Pools, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DbError::sql(e.to_string()))?;
    }
    // 先建写池：它负责在文件不存在时创建数据库并切到 WAL。
    let writer = SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .idle_timeout(None)
        .max_lifetime(None)
        .after_connect(|conn, _| Box::pin(async move { install_authorizer(conn, Role::Writer).await }))
        .connect_with(base_options(path))
        .await?;
    let reader = SqlitePoolOptions::new()
        .max_connections(4)
        .min_connections(0)
        .after_connect(|conn, _| Box::pin(async move { install_authorizer(conn, Role::Reader).await }))
        .connect_with(base_options(path))
        .await?;
    Ok(Pools { reader, writer })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Reader,
    Writer,
}

async fn install_authorizer(conn: &mut SqliteConnection, role: Role) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let callback: unsafe extern "C" fn(*mut c_void, c_int, *const c_char, *const c_char, *const c_char, *const c_char) -> c_int =
        match role {
            Role::Reader => authorize_reader,
            Role::Writer => authorize_writer,
        };
    // SAFETY: db 是本连接的有效句柄，lock_handle 期间独占；回调不持有任何指针。
    let rc = unsafe { ffi::sqlite3_set_authorizer(db, Some(callback), ptr::null_mut()) };
    if rc != ffi::SQLITE_OK {
        return Err(sqlx::Error::Protocol("无法安装 SQLite 授权回调".into()));
    }
    Ok(())
}

/// SAFETY 约定：SQLite 传入的字符串指针要么为空，要么是以 NUL 结尾的 UTF-8。
unsafe fn arg_str<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        None
    } else {
        CStr::from_ptr(p).to_str().ok()
    }
}

fn pragma_allowed(name: Option<&str>, value: Option<&str>, role: Role) -> bool {
    let Some(name) = name.map(str::to_ascii_lowercase) else { return false };
    match name.as_str() {
        // 只读查询：表结构、版本号、日志模式
        "table_info" | "table_xinfo" | "index_list" => true,
        "user_version" | "journal_mode" => value.is_none() || (role == Role::Writer && name == "user_version"),
        "foreign_keys" | "wal_checkpoint" => role == Role::Writer,
        _ => false,
    }
}

unsafe extern "C" fn authorize_writer(
    _: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    _: *const c_char,
    _: *const c_char,
) -> c_int {
    match action {
        ffi::SQLITE_ATTACH | ffi::SQLITE_DETACH => ffi::SQLITE_DENY,
        ffi::SQLITE_PRAGMA => {
            if pragma_allowed(arg_str(arg1), arg_str(arg2), Role::Writer) {
                ffi::SQLITE_OK
            } else {
                ffi::SQLITE_DENY
            }
        }
        _ => ffi::SQLITE_OK,
    }
}

unsafe extern "C" fn authorize_reader(
    _: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    _: *const c_char,
    _: *const c_char,
) -> c_int {
    match action {
        ffi::SQLITE_SELECT | ffi::SQLITE_READ | ffi::SQLITE_FUNCTION | ffi::SQLITE_RECURSIVE => ffi::SQLITE_OK,
        ffi::SQLITE_PRAGMA => {
            if pragma_allowed(arg_str(arg1), arg_str(arg2), Role::Reader) {
                ffi::SQLITE_OK
            } else {
                ffi::SQLITE_DENY
            }
        }
        _ => ffi::SQLITE_DENY,
    }
}

/// 跳过空白与注释后的第一个关键字（大写）。
fn leading_keyword(sql: &str) -> String {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase()
}

/// 在本连接上预编译整段 SQL：必须恰好一条语句；读连接上还必须是只读语句。
/// 授权回调在预编译时生效，被拒的语句在这里就报错。
async fn vet(conn: &mut SqliteConnection, sql: &str, role: Role) -> Result<(), DbError> {
    if matches!(leading_keyword(sql).as_str(), "VACUUM" | "ATTACH" | "DETACH") {
        return Err(DbError::sql("不允许的语句"));
    }
    let mut handle = conn.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let bytes = sql.as_bytes();
    let len = c_int::try_from(bytes.len()).map_err(|_| DbError::sql("语句过长"))?;
    // SAFETY: db 独占；SQL 缓冲区在本函数内有效，按长度传入，不要求 NUL 结尾。
    unsafe {
        let start = bytes.as_ptr().cast::<c_char>();
        let end = start.add(bytes.len());
        let mut cursor = start;
        let mut count = 0usize;
        while cursor < end {
            let mut stmt: *mut ffi::sqlite3_stmt = ptr::null_mut();
            let mut tail: *const c_char = ptr::null();
            let remaining = c_int::try_from(end.offset_from(cursor)).unwrap_or(len);
            let rc = ffi::sqlite3_prepare_v2(db, cursor, remaining, &mut stmt, &mut tail);
            if rc != ffi::SQLITE_OK {
                let message = CStr::from_ptr(ffi::sqlite3_errmsg(db)).to_string_lossy().into_owned();
                return Err(DbError::sql(message));
            }
            if stmt.is_null() {
                break; // 只剩空白或注释
            }
            count += 1;
            let readonly = ffi::sqlite3_stmt_readonly(stmt) != 0;
            ffi::sqlite3_finalize(stmt);
            if count > 1 {
                return Err(DbError::sql("一次只能执行一条语句"));
            }
            if role == Role::Reader && !readonly {
                return Err(DbError::sql("读取通道只接受只读语句"));
            }
            if tail.is_null() || tail <= cursor {
                break;
            }
            cursor = tail;
        }
        if count == 0 {
            return Err(DbError::sql("空语句"));
        }
    }
    Ok(())
}

fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for value in params {
        query = match value {
            Value::Null => query.bind(None::<String>),
            Value::Bool(b) => query.bind(i64::from(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(i) => query.bind(i),
                None => query.bind(n.as_f64().unwrap_or_default()),
            },
            Value::String(s) => query.bind(s.as_str()),
            other => query.bind(other.to_string()),
        };
    }
    query
}

fn to_json(row: &sqlx::sqlite::SqliteRow) -> Result<Map<String, Value>, DbError> {
    let mut out = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "NUMERIC" | "BOOLEAN" => {
                    Value::from(<i64 as Decode<Sqlite>>::decode(raw).map_err(|e| DbError::sql(e.to_string()))?)
                }
                "REAL" => Value::from(<f64 as Decode<Sqlite>>::decode(raw).map_err(|e| DbError::sql(e.to_string()))?),
                "BLOB" => Value::from(<Vec<u8> as Decode<Sqlite>>::decode(raw).map_err(|e| DbError::sql(e.to_string()))?),
                _ => Value::from(<String as Decode<Sqlite>>::decode(raw).map_err(|e| DbError::sql(e.to_string()))?),
            }
        };
        out.insert(column.name().to_string(), value);
    }
    Ok(out)
}

async fn select_on(pool: &SqlitePool, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, DbError> {
    let mut conn = pool.acquire().await?;
    vet(&mut conn, sql, Role::Reader).await?;
    let rows = bind_all(sqlx::query(sql), params).fetch_all(&mut *conn).await?;
    rows.iter().map(to_json).collect()
}

/// 单条写入，自动提交（PRAGMA wal_checkpoint 这类不能放进事务的语句也走这里）。
async fn execute_on(pool: &SqlitePool, sql: &str, params: &[Value]) -> Result<u64, DbError> {
    let mut conn = pool.acquire().await?;
    vet(&mut conn, sql, Role::Writer).await?;
    Ok(bind_all(sqlx::query(sql), params).execute(&mut *conn).await?.rows_affected())
}

async fn batch_on(pool: &SqlitePool, steps: &[Step]) -> Result<Vec<u64>, DbError> {
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let mut out = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let result = async {
            vet(&mut conn, &step.sql, Role::Writer).await?;
            let rows = bind_all(sqlx::query(&step.sql), &step.params).execute(&mut *conn).await?.rows_affected();
            if step.expect.accepts(rows) {
                Ok(rows)
            } else {
                Err(DbError::Conflict { step: index })
            }
        }
        .await;
        match result {
            Ok(rows) => out.push(rows),
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(err);
            }
        }
    }
    if let Err(err) = sqlx::query("COMMIT").execute(&mut *conn).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
        return Err(err.into());
    }
    Ok(out)
}

#[tauri::command]
pub async fn db_select(
    app: AppHandle,
    db: State<'_, Db>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, DbError> {
    let pools = db.pools(&app).await?;
    select_on(&pools.reader, &sql, &params).await
}

#[tauri::command]
pub async fn db_execute(app: AppHandle, db: State<'_, Db>, sql: String, params: Vec<Value>) -> Result<u64, DbError> {
    let pools = db.pools(&app).await?;
    execute_on(&pools.writer, &sql, &params).await
}

#[tauri::command]
pub async fn db_batch(app: AppHandle, db: State<'_, Db>, steps: Vec<Step>) -> Result<Vec<u64>, DbError> {
    let pools = db.pools(&app).await?;
    batch_on(&pools.writer, &steps).await
}

/// 重启前（恢复文库）由前端调用；之后的访问会重新打开连接池。
#[tauri::command]
pub async fn db_close(db: State<'_, Db>) -> Result<(), DbError> {
    db.close().await;
    Ok(())
}

/// 数据库文件路径（供启动阶段的路径规范化等一次性任务使用）。
pub fn database_path(config_dir: &Path) -> PathBuf {
    config_dir.join(DB_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pools(name: &str) -> (PathBuf, Pools) {
        let dir = crate::test_util::unique_temp_dir(&format!("pf-db-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DB_FILE);
        let pools = open_pools(&path).await.unwrap();
        execute_on(&pools.writer, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n REAL)", &[]).await.unwrap();
        (dir, pools)
    }

    fn step(sql: &str, params: Vec<Value>, expect: Expect) -> Step {
        Step { sql: sql.into(), params, expect }
    }

    #[tokio::test]
    async fn execute_reports_rows_and_select_returns_typed_json() {
        let (_dir, p) = pools("rows").await;
        let n = execute_on(&p.writer, "INSERT INTO t (v, n) VALUES (?, ?), (?, ?)", &[json!("a"), json!(1.5), json!(null), json!(2)])
            .await
            .unwrap();
        assert_eq!(n, 2);
        let rows = select_on(&p.reader, "SELECT id, v, n FROM t ORDER BY id", &[]).await.unwrap();
        assert_eq!(rows[0]["v"], json!("a"));
        assert_eq!(rows[0]["n"], json!(1.5));
        assert_eq!(rows[1]["v"], Value::Null);
        assert_eq!(rows[0]["id"], json!(1));
        assert_eq!(execute_on(&p.writer, "UPDATE t SET v = 'x' WHERE v = 'missing'", &[]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn batch_rolls_back_whole_transaction_on_unmet_expectation() {
        let (_dir, p) = pools("conflict").await;
        let err = batch_on(
            &p.writer,
            &[
                step("INSERT INTO t (v) VALUES ('kept?')", vec![], Expect::One),
                step("UPDATE t SET v = 'x' WHERE id = 999", vec![], Expect::One),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(err, DbError::Conflict { step: 1 });
        let rows = select_on(&p.reader, "SELECT count(*) AS c FROM t", &[]).await.unwrap();
        assert_eq!(rows[0]["c"], json!(0));
        // 回滚后连接仍可用
        let ok = batch_on(&p.writer, &[step("INSERT INTO t (v) VALUES ('a')", vec![], Expect::One)]).await.unwrap();
        assert_eq!(ok, vec![1]);
    }

    #[tokio::test]
    async fn batch_sql_error_rolls_back() {
        let (_dir, p) = pools("sqlerr").await;
        let err = batch_on(
            &p.writer,
            &[step("INSERT INTO t (v) VALUES ('a')", vec![], Expect::Any), step("INSERT INTO nope VALUES (1)", vec![], Expect::Any)],
        )
        .await
        .unwrap_err();
        assert!(matches!(err, DbError::Sql { .. }));
        let rows = select_on(&p.reader, "SELECT count(*) AS c FROM t", &[]).await.unwrap();
        assert_eq!(rows[0]["c"], json!(0));
    }

    #[tokio::test]
    async fn migrations_style_ddl_and_user_version_are_transactional() {
        let (_dir, p) = pools("ddl").await;
        let err = batch_on(
            &p.writer,
            &[
                step("ALTER TABLE t ADD COLUMN extra TEXT", vec![], Expect::Any),
                step("PRAGMA user_version = 7", vec![], Expect::Any),
                step("INSERT INTO missing VALUES (1)", vec![], Expect::Any),
            ],
        )
        .await;
        assert!(err.is_err());
        let v = select_on(&p.reader, "PRAGMA user_version", &[]).await.unwrap();
        assert_eq!(v[0]["user_version"], json!(0));
        let cols = select_on(&p.reader, "SELECT name FROM pragma_table_info('t') WHERE name = 'extra'", &[]).await.unwrap();
        assert!(cols.is_empty());
    }

    #[tokio::test]
    async fn rejects_multiple_statements_and_file_writing_statements() {
        let (dir, p) = pools("deny").await;
        let outside = dir.join("evil.db");
        let outside_sql = outside.to_string_lossy().replace('\'', "''");
        for sql in [
            "INSERT INTO t (v) VALUES ('a'); DELETE FROM t".to_string(),
            format!("ATTACH DATABASE '{outside_sql}' AS evil"),
            format!("VACUUM INTO '{outside_sql}'"),
            format!("/* c */ vacuum into '{outside_sql}'"),
            "PRAGMA writable_schema = 1".to_string(),
        ] {
            assert!(execute_on(&p.writer, &sql, &[]).await.is_err(), "writer must reject: {sql}");
        }
        assert!(select_on(&p.reader, &format!("SELECT 1; VACUUM INTO '{outside_sql}'"), &[]).await.is_err());
        assert!(!outside.exists());
        // 尾随分号与注释不算第二条语句
        assert_eq!(execute_on(&p.writer, "INSERT INTO t (v) VALUES ('a'); -- note", &[]).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn reader_cannot_write() {
        let (_dir, p) = pools("reader").await;
        for sql in ["INSERT INTO t (v) VALUES ('a')", "DELETE FROM t", "CREATE TABLE x (a)", "PRAGMA user_version = 3"] {
            assert!(select_on(&p.reader, sql, &[]).await.is_err(), "reader must reject: {sql}");
        }
        assert!(select_on(&p.reader, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3) SELECT count(*) AS n FROM c", &[])
            .await
            .is_ok());
        assert!(select_on(&p.reader, "SELECT json_extract('{\"a\":1}', '$.a') AS a", &[]).await.is_ok());
    }

    #[tokio::test]
    async fn triggers_and_wal_checkpoint_work_on_writer() {
        let (_dir, p) = pools("trigger").await;
        execute_on(
            &p.writer,
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET v = 'set' WHERE id = NEW.id; END",
            &[],
        )
        .await
        .unwrap();
        execute_on(&p.writer, "INSERT INTO t (v) VALUES ('x')", &[]).await.unwrap();
        let rows = select_on(&p.reader, "SELECT v FROM t", &[]).await.unwrap();
        assert_eq!(rows[0]["v"], json!("set"));
        execute_on(&p.writer, "PRAGMA wal_checkpoint(FULL)", &[]).await.unwrap();
        execute_on(&p.writer, "PRAGMA foreign_keys = ON", &[]).await.unwrap();
    }

    #[test]
    fn leading_keyword_skips_comments() {
        assert_eq!(leading_keyword("  -- x\n /* y */ vacuum"), "VACUUM");
        assert_eq!(leading_keyword("SELECT 1"), "SELECT");
        assert_eq!(leading_keyword("/* unterminated"), "");
    }
}
