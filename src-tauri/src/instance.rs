//! 同一时刻只允许一个进程使用文库。
//!
//! 单实例插件让第二次启动只把已有窗口带到前台；这里再加一道跨进程文件锁兜底
//! （不同构建、不同启动方式时插件未必拦得住）：拿不到锁的进程不做恢复、不改写路径，
//! 数据库层也拒绝打开，避免两个进程同时清扫作业、重复提交解析或交错改写同一份数据。

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::OnceLock;

static LOCK: OnceLock<File> = OnceLock::new();

/// 在数据目录上取得排它锁并持有到进程退出。已持有时直接返回 true。
pub fn acquire(dir: &Path) -> bool {
    if LOCK.get().is_some() {
        return true;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let Ok(file) = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("app.lock")) else {
        return false;
    };
    if file.try_lock().is_err() {
        return false;
    }
    LOCK.set(file).is_ok()
}

/// 本进程是否持有文库锁。
pub fn held() -> bool {
    LOCK.get().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_handle_cannot_take_the_lock() {
        let dir = crate::test_util::unique_temp_dir("pf-instance");
        std::fs::create_dir_all(&dir).unwrap();
        let first = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("app.lock")).unwrap();
        first.try_lock().unwrap();
        let second = OpenOptions::new().write(true).open(dir.join("app.lock")).unwrap();
        assert!(second.try_lock().is_err(), "a second process must not get the library lock");
        drop(first);
        assert!(second.try_lock().is_ok());
    }
}
