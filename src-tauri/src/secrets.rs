use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

/// One process-wide lock per secrets file. Two `store_for` values that point
/// at the same path share it, so overlapping load-modify-save cannot drop a key.
fn file_locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static FILE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    FILE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_lock(path: &Path) -> Arc<Mutex<()>> {
    let mut map = file_locks().lock().unwrap_or_else(|err| err.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn with_file_lock<T>(path: &Path, body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = file_lock(path);
    #[cfg(test)]
    let counting = test_pause::targets(path);
    #[cfg(test)]
    if counting {
        test_pause::WAITERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    let guard = lock.lock().unwrap_or_else(|err| err.into_inner());
    #[cfg(test)]
    if counting {
        test_pause::WAITERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
    let result = body();
    drop(guard);
    result
}

#[cfg(test)]
mod test_pause {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Condvar;
    use std::time::{Duration, Instant};

    pub static WAITERS: AtomicUsize = AtomicUsize::new(0);

    struct Gate {
        path: Mutex<Option<PathBuf>>,
        consumed: AtomicBool,
        entered: Mutex<bool>,
        entered_cv: Condvar,
        released: Mutex<bool>,
        release_cv: Condvar,
    }

    fn gate() -> &'static Gate {
        static GATE: OnceLock<Gate> = OnceLock::new();
        GATE.get_or_init(|| Gate {
            path: Mutex::new(None),
            consumed: AtomicBool::new(false),
            entered: Mutex::new(false),
            entered_cv: Condvar::new(),
            released: Mutex::new(false),
            release_cv: Condvar::new(),
        })
    }

    pub fn targets(path: &Path) -> bool {
        gate()
            .path
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
            == Some(&path.to_path_buf())
    }

    pub fn arm(path: &Path) {
        let gate = gate();
        *gate.path.lock().unwrap_or_else(|err| err.into_inner()) = Some(path.to_path_buf());
        gate.consumed.store(false, Ordering::SeqCst);
        *gate.entered.lock().unwrap_or_else(|err| err.into_inner()) = false;
        *gate.released.lock().unwrap_or_else(|err| err.into_inner()) = false;
        WAITERS.store(0, Ordering::SeqCst);
    }

    pub fn disarm() {
        *gate().path.lock().unwrap_or_else(|err| err.into_inner()) = None;
    }

    /// First `set` on the armed path stops after load, still holding the file lock.
    pub fn pause_after_load(path: &Path) {
        if !targets(path) {
            return;
        }
        let gate = gate();
        if gate.consumed.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let mut entered = gate.entered.lock().unwrap_or_else(|err| err.into_inner());
            *entered = true;
            gate.entered_cv.notify_all();
        }
        let mut released = gate.released.lock().unwrap_or_else(|err| err.into_inner());
        while !*released {
            released = gate
                .release_cv
                .wait(released)
                .unwrap_or_else(|err| err.into_inner());
        }
    }

    pub fn wait_until_entered() {
        let gate = gate();
        let mut entered = gate.entered.lock().unwrap_or_else(|err| err.into_inner());
        let started = Instant::now();
        while !*entered {
            let (next, timeout) = gate
                .entered_cv
                .wait_timeout(entered, Duration::from_secs(5))
                .unwrap_or_else(|err| err.into_inner());
            entered = next;
            if timeout.timed_out() && !*entered {
                panic!("set did not pause between load and save");
            }
            if started.elapsed() > Duration::from_secs(5) && !*entered {
                panic!("set did not pause between load and save");
            }
        }
    }

    pub fn release() {
        let gate = gate();
        let mut released = gate.released.lock().unwrap_or_else(|err| err.into_inner());
        *released = true;
        gate.release_cv.notify_all();
    }
}

#[cfg(test)]
fn pause_after_load(path: &Path) {
    test_pause::pause_after_load(path);
}

#[cfg(not(test))]
fn pause_after_load(_path: &Path) {}

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Clearing a saved key writes an empty secret through `set`.
    #[allow(dead_code)]
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[cfg(test)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl MemorySecretStore {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .map
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(account)
            .cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap_or_else(|err| err.into_inner());
        if secret.is_empty() {
            map.remove(account);
        } else {
            map.insert(account.to_string(), secret.to_string());
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

pub fn llm_account(provider_id: &str) -> String {
    format!("llm:{provider_id}")
}

pub const MINERU_ACCOUNT: &str = "mineru:token";

/// Service name in macOS Keychain and Windows Credential Manager.
///
/// This does not follow the bundle identifier. Entries saved while the app
/// was `com.paperfield.app` stay under `paper-field`, so the move to
/// `com.paperfield.notes` does not orphan them. Linux keeps the same accounts
/// in `secrets.json`, which the app-support copy migrates with the other files.
pub const KEYCHAIN_SERVICE: &str = "paper-field";

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg_attr(test, allow(dead_code))]
pub struct KeyringStore;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
        if secret.is_empty() {
            return match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            };
        }
        entry.set_password(secret).map_err(|err| err.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

/// Linux builds (this dev VM) have no macOS Keychain. Secrets stay out of the
/// settings JSON, in a mode-0600 file. macOS and Windows use the keyring crate.
#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
pub struct FileSecretStore {
    path: std::path::PathBuf,
}

#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
impl FileSecretStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("secrets.json"),
        }
    }

    fn load(&self) -> Result<HashMap<String, String>, String> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let raw = fs::read_to_string(&self.path).map_err(|err| format!("secrets.json 无法读取：{err}"))?;
        serde_json::from_str(&raw).map_err(|err| format!("secrets.json 无法解析：{err}"))
    }

    fn save(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let raw = serde_json::to_string(map).map_err(|err| err.to_string())?;
        #[cfg(unix)]
        return crate::io_util::atomic_write_private(&self.path, raw.as_bytes());
        #[cfg(not(unix))]
        crate::io_util::atomic_write(&self.path, raw.as_bytes())
    }
}

#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
impl SecretStore for FileSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        with_file_lock(&self.path, || Ok(self.load()?.get(account).cloned()))
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        with_file_lock(&self.path, || {
            let mut map = self.load()?;
            pause_after_load(&self.path);
            if secret.is_empty() {
                map.remove(account);
            } else {
                map.insert(account.to_string(), secret.to_string());
            }
            self.save(&map)
        })
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

/// Tests never reach the real OS keychain: under `cfg(test)` every platform
/// uses the file store inside `dir` (a per-test temp dir).
///
/// Caveat: `cfg(test)` only covers this crate's unit tests. Integration tests
/// under `tests/`, other features, or bins calling `store_for` still compile
/// without `cfg(test)` and would hit the real keychain on macOS/Windows.
pub fn store_for(dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(all(any(target_os = "macos", target_os = "windows"), not(test)))]
    {
        let _ = dir;
        Box::new(KeyringStore)
    }
    #[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
    {
        Box::new(FileSecretStore::new(dir))
    }
}

pub fn redact_secrets(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < chars.len() {
        if has_prefix(&chars[index..], "sk-") {
            let token = token_len(&chars[index + 3..], true);
            if token >= 4 {
                out.push_str("sk-…");
                index += 3 + token;
                continue;
            }
        }
        if has_prefix_ignore_case(&chars[index..], "bearer ") {
            let token = token_len(&chars[index + 7..], false);
            if token >= 4 {
                out.push_str("Bearer …");
                index += 7 + token;
                continue;
            }
        }
        // JWT：三段 base64url，头部 `{"` 编码后固定以 eyJ 开头（MinerU Token 即此形状）。
        if has_prefix(&chars[index..], "eyJ") && (index == 0 || !is_token_char(chars[index - 1])) {
            let first = token_len(&chars[index..], true);
            let second = chars.get(index + first).filter(|ch| **ch == '.').map(|_| token_len(&chars[index + first + 1..], true));
            if first >= 11 && second.is_some_and(|len| len >= 8) {
                let mut end = index + first + 1 + second.unwrap_or(0);
                if chars.get(end) == Some(&'.') {
                    end += 1 + token_len(&chars[end + 1..], true);
                }
                out.push_str("eyJ…");
                index = end;
                continue;
            }
        }
        // 头部写法：x-api-key: xxx、"x-goog-api-key": "xxx"。
        if let Some(skip) = header_key_prefix(&chars[index..]) {
            let token = token_len(&chars[index + skip..], false);
            if token >= 8 {
                out.extend(&chars[index..index + skip]);
                out.push('…');
                index += skip + token;
                continue;
            }
        }
        // 查询参数：?api_key=…、&X-Amz-Signature=…
        if matches!(chars[index], '?' | '&') {
            if let Some(name) = secret_param_len(&chars[index + 1..]) {
                let value = chars[index + 1 + name..].iter().take_while(|ch| !is_param_end(**ch)).count();
                if value > 0 {
                    out.extend(&chars[index..=index + name]);
                    out.push('…');
                    index += 1 + name + value;
                    continue;
                }
            }
        }
        // scheme://user:pass@host → scheme://***@host
        if has_prefix(&chars[index..], "://") {
            let info = chars[index + 3..].iter().take_while(|ch| !matches!(ch, '/' | '?' | '#' | '@' | '"' | '\'' | '<' | '>') && !ch.is_whitespace()).count();
            if info > 0 && chars.get(index + 3 + info) == Some(&'@') {
                out.push_str("://***@");
                index += 3 + info + 1;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn has_prefix(chars: &[char], prefix: &str) -> bool {
    let prefix: Vec<char> = prefix.chars().collect();
    chars.len() >= prefix.len() && chars[..prefix.len()] == prefix[..]
}

fn has_prefix_ignore_case(chars: &[char], prefix: &str) -> bool {
    let prefix: Vec<char> = prefix.chars().collect();
    if chars.len() < prefix.len() {
        return false;
    }
    chars[..prefix.len()]
        .iter()
        .zip(prefix.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn is_param_end(ch: char) -> bool {
    matches!(ch, '&' | '#' | '"' | '\'' | '<' | '>') || ch.is_whitespace()
}

/// 值是凭据或请求签名的查询参数名（预签名 S3/OSS 链接带 X-Amz-Signature、Signature 等）。
const SECRET_PARAMS: &[&str] = &[
    "key", "api_key", "apikey", "api-key", "token", "access_token", "refresh_token", "id_token", "auth",
    "signature", "sig", "x-amz-signature", "x-amz-credential", "x-amz-security-token", "x-goog-signature",
    "x-goog-credential", "client_secret", "secret", "password",
];

/// 返回参数名长度（含 `=`）。
fn secret_param_len(chars: &[char]) -> Option<usize> {
    let name = chars.iter().take_while(|ch| **ch != '=' && !is_param_end(**ch)).count();
    if chars.get(name) != Some(&'=') {
        return None;
    }
    let lower: String = chars[..name].iter().collect::<String>().to_ascii_lowercase();
    SECRET_PARAMS.contains(&lower.as_str()).then_some(name + 1)
}

/// `x-api-key` 等头名后跟可选引号、`:` 或 `=`、空白：返回到值开头的长度。
fn header_key_prefix(chars: &[char]) -> Option<usize> {
    let name = ["x-api-key", "x-goog-api-key", "api-key"]
        .iter()
        .find(|name| has_prefix_ignore_case(chars, name))?
        .len();
    let mut at = name;
    if matches!(chars.get(at), Some('"' | '\'')) {
        at += 1;
    }
    while chars.get(at).is_some_and(|ch| *ch == ' ') {
        at += 1;
    }
    if !matches!(chars.get(at), Some(':' | '=')) {
        return None;
    }
    at += 1;
    while chars.get(at).is_some_and(|ch| *ch == ' ') {
        at += 1;
    }
    if matches!(chars.get(at), Some('"' | '\'')) {
        at += 1;
    }
    Some(at)
}

fn token_len(chars: &[char], sk: bool) -> usize {
    chars
        .iter()
        .take_while(|ch| {
            if sk {
                ch.is_ascii_alphanumeric() || **ch == '_' || **ch == '-'
            } else {
                ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~' | '+' | '/' | '=')
            }
        })
        .count()
}

/// Empty secret-shaped fields in a JSON document. Invalid JSON is redacted as text.
pub fn scrub_json_secrets(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return redact_secrets(raw);
    };
    scrub_value(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| redact_secrets(raw))
}

fn scrub_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in ["apiKey", "api_key", "token", "authorization", "Authorization"] {
                if map.contains_key(key) {
                    map.insert(key.to_string(), Value::String(String::new()));
                }
            }
            for child in map.values_mut() {
                scrub_value(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_value(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_stays_paper_field_across_bundle_id_change() {
        assert_eq!(KEYCHAIN_SERVICE, "paper-field");
        assert!(!KEYCHAIN_SERVICE.contains("com.paperfield"));
        assert_ne!(KEYCHAIN_SERVICE, crate::appdir::NEW_IDENTIFIER);
        assert_ne!(KEYCHAIN_SERVICE, crate::appdir::OLD_IDENTIFIER);
    }

    #[test]
    fn memory_store_round_trip_and_delete() {
        let store = MemorySecretStore::new();
        store.set("llm:p", "sk-test").unwrap();
        assert_eq!(store.get("llm:p").unwrap().as_deref(), Some("sk-test"));
        store.delete("llm:p").unwrap();
        assert_eq!(store.get("llm:p").unwrap(), None);
    }

    #[test]
    fn redacts_sk_and_bearer_fragments() {
        let raw = "Incorrect API key provided: sk-abcDEF123456 and Bearer sk-live-secret.tail";
        let cleaned = redact_secrets(raw);
        assert!(!cleaned.contains("sk-abcDEF123456"), "{cleaned}");
        assert!(cleaned.contains("sk-…"), "{cleaned}");
        assert!(!cleaned.to_ascii_lowercase().contains("bearer sk"), "{cleaned}");
        assert!(cleaned.contains("Bearer …"), "{cleaned}");
    }

    #[test]
    fn redacts_jwt_header_keys_query_secrets_and_userinfo() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFkZXIifQ.c2lnbmF0dXJlX3ZhbHVl";
        let raw = format!(
            "token {jwt} | x-api-key: abcd1234efgh | \"x-goog-api-key\": \"AIzaSyXXXXXXXX\" | \
             https://oss.example/a.zip?X-Amz-Signature=deadbeef&id=7 | https://user:pa55@api.example/v1"
        );
        let cleaned = redact_secrets(&raw);
        for leaked in [jwt, "abcd1234efgh", "AIzaSyXXXXXXXX", "deadbeef", "pa55"] {
            assert!(!cleaned.contains(leaked), "{leaked} 泄露：{cleaned}");
        }
        assert!(cleaned.contains("eyJ…"), "{cleaned}");
        assert!(cleaned.contains("x-api-key: …"), "{cleaned}");
        assert!(cleaned.contains("?X-Amz-Signature=…&id=7"), "{cleaned}");
        assert!(cleaned.contains("https://***@api.example/v1"), "{cleaned}");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        for text in [
            "the token expired",
            "x-api-key: missing",
            "https://doi.org/10.1/abc?page=2&monkey=1",
            "mail reader@example.com",
            "论文：eyJ 不是令牌",
        ] {
            assert_eq!(redact_secrets(text), text);
        }
    }

    #[test]
    fn scrub_json_clears_nested_keys_but_keeps_other_fields() {
        let raw = r#"{"version":1,"apiKey":"sk-old","providers":[{"id":"p","apiKey":"sk-keep","model":"m"}]}"#;
        let cleaned = scrub_json_secrets(raw);
        assert!(!cleaned.contains("sk-old"), "{cleaned}");
        assert!(!cleaned.contains("sk-keep"), "{cleaned}");
        assert!(cleaned.contains("\"model\""), "{cleaned}");
    }

    // ---- Tester #7 repro: secrets file must be 0600 from creation, never via symlink ----
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "windows"))))]
    mod tester_perm {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        fn dir(n: &str) -> std::path::PathBuf {
            crate::test_util::unique_temp_dir(&format!("pf-tester-sec-{n}"))
        }

        #[test]
        fn tester_secrets_final_mode_is_0600() {
            let d = dir("mode");
            FileSecretStore::new(&d).set("k", "sk-secret").unwrap();
            let m = std::fs::metadata(d.join("secrets.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600);
        }

        #[test]
        fn tester_secrets_tmp_symlink_is_not_followed() {
            // Attacker pre-plants secrets.json.tmp -> file they can read.
            let d = dir("link");
            let bait = d.join("attacker-readable");
            std::fs::write(&bait, b"").unwrap();
            std::fs::set_permissions(&bait, std::fs::Permissions::from_mode(0o644)).unwrap();
            std::os::unix::fs::symlink(&bait, d.join("secrets.json.tmp")).unwrap();
            let _ = FileSecretStore::new(&d).set("k", "sk-secret");
            let leaked = std::fs::read_to_string(&bait).unwrap();
            assert!(!leaked.contains("sk-secret"), "secret written through symlink into 0644 file: {leaked}");
        }

        #[test]
        fn tester_secrets_first_write_never_world_readable() {
            // The bytes must never sit in a file with group/other bits. Observe the mode of the
            // inode that receives the data by pre-creating the tmp path as a hard link we keep.
            let d = dir("first");
            let tmp = d.join("secrets.json.tmp");
            std::fs::write(&tmp, b"").unwrap();
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
            let keep = d.join("observer");
            std::fs::hard_link(&tmp, &keep).unwrap();
            let _ = FileSecretStore::new(&d).set("k", "sk-secret");
            let data = std::fs::read_to_string(&keep).unwrap_or_default();
            let m = std::fs::metadata(&keep).unwrap().permissions().mode() & 0o777;
            assert!(!(data.contains("sk-secret") && m & 0o077 != 0),
                "secret sat in mode {m:o} inode (create_new should refuse an existing tmp)");
        }
    }

    #[test]
    fn overlapping_sets_from_two_stores_keep_both_keys() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pf-secret-lock-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");
        test_pause::arm(&path);

        let first = store_for(&dir);
        let second = store_for(&dir);
        let writer_a = std::thread::spawn(move || first.set("k1", "v1").unwrap());
        test_pause::wait_until_entered();
        let writer_b = std::thread::spawn(move || second.set("k2", "v2").unwrap());
        let started = std::time::Instant::now();
        while test_pause::WAITERS.load(std::sync::atomic::Ordering::SeqCst) < 1 {
            if writer_b.is_finished() {
                break;
            }
            if started.elapsed() > std::time::Duration::from_secs(5) {
                test_pause::release();
                panic!("second set did not reach the shared file lock");
            }
            std::thread::yield_now();
        }
        test_pause::release();
        writer_a.join().unwrap();
        writer_b.join().unwrap();

        let check = store_for(&dir);
        assert_eq!(check.get("k1").unwrap().as_deref(), Some("v1"));
        assert_eq!(check.get("k2").unwrap().as_deref(), Some("v2"));
        test_pause::disarm();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_for_in_tests_stays_inside_dir_on_every_platform() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pf-store-for-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let store = store_for(&d);
        store.set("llm:guard", "sk-guard-value").unwrap();
        assert_eq!(store.get("llm:guard").unwrap().as_deref(), Some("sk-guard-value"));
        assert!(fs::read_dir(&d).unwrap().next().is_some(), "secret must be written under the test dir");
        store.delete("llm:guard").unwrap();
        let _ = fs::remove_dir_all(&d);
    }
}
