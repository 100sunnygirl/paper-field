//! 运行日志落盘（前端 src/lib/logger.ts）。
//!
//! 以前前端经 tauri-plugin-store 读写 `app-log.json`，但插件按渲染进程给的任意路径解析
//! （绝对路径、`..` 都能逃出数据目录），注入脚本可借它改写 llm-settings.json 把 Key 发往别处。
//! 现在只有这三个命令：文件名写死、大小封顶，渲染进程碰不到别的文件。
//! 位置与格式不变（AppData 下的 `app-log.json`，`{"entries": [...]}`），旧日志照常回读。
//! 文件名与 llm-settings.json / mineru-settings.json 永久错开（0.2.6 事故教训：同名同目录会互相覆盖）。

#![deny(clippy::string_slice)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const LOG_FILE: &str = "app-log.json";
const ENTRIES_KEY: &str = "entries";
/// 条数上限：与前端内存缓冲（LOG_BUFFER_LIMIT）一致，前端只落盘其中最新 200 条。
const MAX_ENTRIES: usize = 500;
/// 文件大小上限：超过就当作没有（读）或拒绝（写），日志不能把磁盘或内存撑爆。
const MAX_BYTES: usize = 1024 * 1024;

fn log_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(LOG_FILE))
}

/// 上次会话落盘的条目；没有文件、过大或解析失败时返回 null（前端按「无历史」处理）。
#[tauri::command]
pub async fn app_log_read(app: AppHandle) -> Result<Value, String> {
    let path = log_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_at(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn app_log_write(app: AppHandle, entries: Vec<Value>) -> Result<(), String> {
    let path = log_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_at(&path, entries))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn app_log_clear(app: AppHandle) -> Result<(), String> {
    let path = log_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_at(&path, Vec::new()))
        .await
        .map_err(|e| e.to_string())?
}

fn read_at(path: &Path) -> Result<Value, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_BYTES as u64 => {}
        Ok(_) => return Ok(Value::Null),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(format!("运行日志无法读取：{e}")),
    }
    let bytes = fs::read(path).map_err(|e| format!("运行日志无法读取：{e}"))?;
    let Ok(Value::Object(mut map)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(Value::Null);
    };
    Ok(match map.remove(ENTRIES_KEY) {
        Some(Value::Array(items)) => {
            let skip = items.len().saturating_sub(MAX_ENTRIES);
            Value::Array(items.into_iter().skip(skip).collect())
        }
        _ => Value::Null,
    })
}

fn write_at(path: &Path, mut entries: Vec<Value>) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    let mut body = serde_json::Map::new();
    body.insert(ENTRIES_KEY.into(), Value::Array(entries));
    let bytes = serde_json::to_vec_pretty(&Value::Object(body)).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("运行日志过大，未写入".into());
    }
    crate::io_util::atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(name: &str) -> PathBuf {
        crate::test_util::unique_temp_dir(&format!("pf-applog-{name}")).join(LOG_FILE)
    }

    #[test]
    fn reads_the_plugin_store_format_written_by_older_versions() {
        let path = file("legacy");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // tauri-plugin-store 的落盘格式：顶层对象，键 entries，pretty JSON。
        fs::write(&path, br#"{
  "entries": [{"seq": 1, "ts": "2026-10-01T00:00:00.000Z", "level": "info", "scope": "app", "message": "old"}]
}"#)
        .unwrap();
        assert_eq!(read_at(&path).unwrap()[0]["message"], "old");
    }

    #[test]
    fn round_trips_and_clears() {
        let path = file("roundtrip");
        assert_eq!(read_at(&path).unwrap(), Value::Null);
        write_at(&path, vec![json!({"seq": 1, "message": "a"})]).unwrap();
        assert_eq!(read_at(&path).unwrap(), json!([{"seq": 1, "message": "a"}]));
        write_at(&path, Vec::new()).unwrap();
        assert_eq!(read_at(&path).unwrap(), json!([]));
    }

    #[test]
    fn caps_entry_count_and_size() {
        let path = file("caps");
        let many: Vec<Value> = (0..MAX_ENTRIES + 10).map(|i| json!({"seq": i})).collect();
        write_at(&path, many).unwrap();
        let back = read_at(&path).unwrap();
        assert_eq!(back.as_array().unwrap().len(), MAX_ENTRIES);
        assert_eq!(back[0]["seq"], 10);
        let huge = vec![json!({"message": "x".repeat(MAX_BYTES)})];
        assert!(write_at(&path, huge).is_err());
        assert_eq!(read_at(&path).unwrap().as_array().unwrap().len(), MAX_ENTRIES, "old log kept");
        // 外部塞进来的超大文件：当作没有，不读进内存
        fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
        assert_eq!(read_at(&path).unwrap(), Value::Null);
    }

    #[test]
    fn unexpected_shapes_read_as_null() {
        let path = file("shape");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for raw in [&b"[1,2]"[..], b"{\"entries\": 3}", b"not json", b"{}"] {
            fs::write(&path, raw).unwrap();
            assert_eq!(read_at(&path).unwrap(), Value::Null);
        }
    }
}
