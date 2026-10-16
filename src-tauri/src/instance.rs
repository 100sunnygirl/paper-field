//! 同一时刻只允许一个进程使用文库。
//!
//! 单实例插件让第二次启动只把已有窗口带到前台；这里再加一道跨进程文件锁兜底
//! （不同构建、不同启动方式时插件未必拦得住）：拿不到锁的进程不做恢复、不改写路径，
//! 数据库层也拒绝打开，避免两个进程同时清扫作业、重复提交解析或交错改写同一份数据。

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static LOCK: Mutex<Option<File>> = Mutex::new(None);

/// 应用自己重启（恢复文库、安装更新后）时，旧进程可能还没退出、锁还没放：等它这么久。
/// 真正的第二个实例在单实例插件那里就已经退出了，走不到这里。
const RELAUNCH_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
enum Locked {
    Yes,
    /// 等满宽限期仍被别的进程持有
    Busy,
    /// 文件系统不支持加锁（如部分网络盘）
    Unsupported,
}

fn lock_with_grace(file: &File, grace: Duration) -> Locked {
    let deadline = Instant::now() + grace;
    loop {
        match file.try_lock() {
            Ok(()) => return Locked::Yes,
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Err(TryLockError::WouldBlock) => return Locked::Busy,
            Err(TryLockError::Error(err)) => {
                eprintln!("[paper-field] 数据目录不支持文件锁（{err}），只靠单实例保护");
                return Locked::Unsupported;
            }
        }
    }
}

/// 在数据目录上取得排它锁并持有到退出。已持有时直接返回 true。
pub fn acquire(dir: &Path) -> bool {
    let mut guard = LOCK.lock().unwrap_or_else(|err| err.into_inner());
    if guard.is_some() {
        return true;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let Ok(file) = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("app.lock")) else {
        return false;
    };
    // 不支持加锁的文件系统不能把用户挡在自己的文库外面。
    if lock_with_grace(&file, RELAUNCH_GRACE) == Locked::Busy {
        return false;
    }
    *guard = Some(file);
    true
}

/// 本进程是否持有文库锁。
pub fn held() -> bool {
    LOCK.lock().unwrap_or_else(|err| err.into_inner()).is_some()
}

/// 退出时释放锁。Tauri 在 `RunEvent::Exit` 之后才拉起重启的新进程，所以要在那里调用，
/// 否则新进程会撞上还没退出的旧进程的锁。
pub fn release() {
    LOCK.lock().unwrap_or_else(|err| err.into_inner()).take();
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

    #[test]
    fn waits_for_a_relaunching_process_to_let_go() {
        let dir = crate::test_util::unique_temp_dir("pf-instance-grace");
        std::fs::create_dir_all(&dir).unwrap();
        let old = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("app.lock")).unwrap();
        old.try_lock().unwrap();
        let new = OpenOptions::new().write(true).open(dir.join("app.lock")).unwrap();
        assert_eq!(lock_with_grace(&new, Duration::from_millis(200)), Locked::Busy);
        let exiting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(old);
        });
        assert_eq!(lock_with_grace(&new, Duration::from_secs(5)), Locked::Yes);
        exiting.join().unwrap();
    }
}
