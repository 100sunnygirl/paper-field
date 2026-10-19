//! External-command transport for MinerU doclib.
//!
//! The MinerU provider logic stays independent of the host OS; this module is
//! the only place that knows how requests are carried by curl, ssh, and scp.
#![deny(clippy::string_slice)]

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub(crate) struct SshResolved {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity: Option<String>,
    pub socket_path: String,
    pub inbox_dir: String,
}

/// Transport target for a doclib-compatible MinerU deployment.
pub(crate) enum DoclibTransport {
    Local(String),
    Ssh(SshResolved),
}

impl DoclibTransport {
    pub(crate) async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        max_time: u64,
        connect_timeout: u64,
    ) -> Result<String, String> {
        match self {
            Self::Local(socket) => local_request(socket, method, path, body, max_time).await,
            Self::Ssh(ssh) => {
                remote_request(ssh, method, path, body, max_time, connect_timeout).await
            }
        }
    }

    pub(crate) async fn get_many(
        &self,
        paths: &[String],
        max_time: u64,
        connect_timeout: u64,
    ) -> Result<Vec<String>, String> {
        match self {
            Self::Local(socket) => {
                let mut bodies = Vec::with_capacity(paths.len());
                for path in paths {
                    bodies.push(local_request(socket, "GET", path, None, max_time).await?);
                }
                Ok(bodies)
            }
            Self::Ssh(ssh) => remote_get_many(ssh, paths, max_time, connect_timeout).await,
        }
    }

    pub(crate) async fn upload_pdf(
        &self,
        pdf: &Path,
        paper_id: &str,
        connect_timeout: u64,
    ) -> Result<String, String> {
        let Self::Ssh(ssh) = self else {
            return Err("本地 MinerU 源不需要上传 PDF".into());
        };
        if !valid_inbox_dir(&ssh.inbox_dir) {
            return Err(INBOX_RULE.into());
        }
        if paper_id.is_empty() || !paper_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("论文编号无效".into());
        }
        let home = remote_home(ssh, connect_timeout).await?;
        let inbox = expand_remote_tilde(&ssh.inbox_dir, &home);
        // 远端 $HOME 也会拼进 scp 路径，同样过一遍白名单。
        if !valid_inbox_dir(&inbox) {
            return Err(format!("远程暂存目录展开后含有不支持的字符：{}", clip(&inbox)));
        }
        ssh_exec(
            ssh,
            &format!("mkdir -p {}", quote_posix_remote_command(&inbox)),
            None,
            connect_timeout,
            "创建远程暂存目录",
        )
        .await?;
        let remote_file = format!("{inbox}/{paper_id}.pdf");
        let mut cmd = new_command("scp");
        push_ssh_opts(&mut cmd, "-P", ssh, connect_timeout);
        cmd.arg("--")
            .arg(pdf)
            .arg(format!("{}:{remote_file}", ssh_target(ssh)));
        let output = run_command(cmd, None).await?;
        command_text(&output, "scp", "上传 PDF 到远程暂存目录")
            .map_err(|e| hint_local_read_timeout(&e))?;
        Ok(remote_file)
    }
}

pub(crate) fn expand_remote_tilde(path: &str, home: &str) -> String {
    if path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        path.to_string()
    }
}

/// 设置界面与 `valid_inbox_dir` 共用的提示。
pub(crate) const INBOX_RULE: &str = "远程暂存目录只能包含字母、数字和 . _ / ~ -，不能以 - 开头，也不能含 .. 段";

/// 远程暂存目录白名单 `[A-Za-z0-9._/~-]`：旧版 scp 协议（OpenSSH < 9.0，Windows 10 自带 8.1）
/// 把 `host:路径` 交给远端 shell 解释，`$()`、反引号、`;`、`|` 等会在 MinerU 服务器上执行。
/// `~` 只能作为开头的 `~` 或 `~/`（由 `expand_remote_tilde` 展开）；`-` 开头会被 mkdir 当成选项；
/// 不接受 `..` 段。保存设置与真正上传前都要调用。
pub(crate) fn valid_inbox_dir(path: &str) -> bool {
    let rest = if path == "~" { "" } else { path.strip_prefix("~/").unwrap_or(path) };
    !path.is_empty()
        && path.len() <= 512
        && !rest.starts_with(['-', '~'])
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '~' | '-'))
        && !rest.split('/').any(|part| part == "..")
}

pub(crate) fn quote_posix_remote_command(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Windows：CREATE_NO_WINDOW。release 是 GUI 子系统，不加这个每次轮询都会闪一下控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 所有子进程（curl/ssh/scp）都从这里建，统一带上 Windows 不弹窗标志。
fn new_command(program: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// 子进程输出只收这么多：stdout 超出算失败（远端或本地服务异常），stderr 超出只截断。
const MAX_STDOUT: u64 = 64 << 20;
const MAX_STDERR: u64 = 1 << 20;

async fn run_command(cmd: Command, stdin_data: Option<&[u8]>) -> Result<std::process::Output, String> {
    run_command_capped(cmd, stdin_data, MAX_STDOUT, MAX_STDERR).await
}

/// 最多读 `cap` 字节；超出的部分读掉丢弃（不读的话子进程会卡在写满的管道上）。返回是否超出。
async fn read_capped(pipe: Option<impl AsyncRead + Unpin>, cap: u64) -> std::io::Result<(Vec<u8>, bool)> {
    let mut buf = Vec::new();
    let Some(pipe) = pipe else { return Ok((buf, false)) };
    let mut limited = pipe.take(cap);
    limited.read_to_end(&mut buf).await?;
    let extra = tokio::io::copy(&mut limited.into_inner(), &mut tokio::io::sink()).await?;
    Ok((buf, extra > 0))
}

async fn run_command_capped(
    mut cmd: Command,
    stdin_data: Option<&[u8]>,
    max_stdout: u64,
    max_stderr: u64,
) -> Result<std::process::Output, String> {
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let program = cmd.as_std().get_program().to_string_lossy().to_string();
    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("找不到 {program} 命令，请确认它已安装并在 PATH 中")
        } else {
            err.to_string()
        }
    })?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data).await.map_err(|e| e.to_string())?;
            // curl --data-binary @- and ssh both need EOF after the request body.
            drop(stdin);
        }
    }
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let ((stdout, stdout_over), (stderr, _), status) = tokio::try_join!(
        read_capped(stdout, max_stdout),
        read_capped(stderr, max_stderr),
        child.wait(),
    )
    .map_err(|e| e.to_string())?;
    if stdout_over {
        return Err(format!("{program} 输出超过 {} MB，已放弃这次结果", max_stdout >> 20));
    }
    Ok(std::process::Output { status, stdout, stderr })
}

/// scp read timeouts are often caused by cloud placeholders rather than SSH.
fn hint_local_read_timeout(message: &str) -> String {
    if message.contains("read local") && message.contains("Operation timed out") {
        format!(
            "{message}（本地文件读取超时：该 PDF 可能在 iCloud/云盘中尚未下载到本机，\
             请先双击打开该文件完成下载，再重新解析）"
        )
    } else {
        message.to_string()
    }
}

/// `program` 是实际执行的命令（curl/ssh/scp），`op` 是报错时告诉用户的那一步。
fn command_text(output: &std::process::Output, program: &str, op: &str) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = if stderr.trim().is_empty() {
        clip(stdout.trim())
    } else {
        clip(stderr.trim())
    };
    // 只有 ssh/scp 自己的登录失败才是「登录被拒绝」；本地 socket、远端目录的权限错误照实报出是哪一步。
    // accept-new 只自动接受首次见到的主机；密钥变了 OpenSSH 拒绝连接，原文是一大片 @@@ 警告。
    if matches!(program, "ssh" | "scp") && is_host_key_mismatch(&stderr) {
        return Err(HOST_KEY_CHANGED.into());
    }
    if matches!(program, "ssh" | "scp") && is_ssh_auth_failure(&stderr) {
        return Err("SSH 登录被拒绝，请检查用户和私钥".into());
    }
    if detail.contains("Permission denied") {
        return Err(format!("{op}时权限不足：{detail}"));
    }
    Err(if detail.is_empty() {
        format!("{op}失败")
    } else {
        detail
    })
}

const HOST_KEY_CHANGED: &str = "SSH 服务器的主机密钥与上次记录的不一致，已拒绝连接（可能是服务器重装，也可能是中间人攻击）。\
     请向服务器管理员核实指纹后，再从 known_hosts 中删除旧记录";

fn is_host_key_mismatch(stderr: &str) -> bool {
    stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || stderr.contains("Host key verification failed")
}

/// OpenSSH 鉴权失败：`Permission denied (publickey,password).` 或密码重试提示。
fn is_ssh_auth_failure(stderr: &str) -> bool {
    if stderr.contains("Permission denied, please try again") {
        return true;
    }
    stderr.split("Permission denied (").skip(1).any(|rest| {
        rest.split(')').next().unwrap_or("").split(',').any(|method| {
            let method = method.trim();
            matches!(method, "publickey" | "password" | "keyboard-interactive" | "hostbased")
                || method.starts_with("gssapi")
        })
    })
}

fn clip(value: &str) -> String {
    value.chars().take(280).collect()
}

fn push_ssh_opts(cmd: &mut Command, port_flag: &str, settings: &SshResolved, connect_timeout: u64) {
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o")
        .arg(format!("ConnectTimeout={connect_timeout}"));
    cmd.arg("-o").arg("ServerAliveInterval=5");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg(port_flag).arg(settings.port.to_string());
    if let Some(key) = &settings.identity {
        cmd.arg("-o").arg("IdentitiesOnly=yes");
        cmd.arg("-i").arg(key);
    }
}

fn ssh_target(settings: &SshResolved) -> String {
    format!("{}@{}", settings.user, settings.host)
}

async fn ssh_exec(
    settings: &SshResolved,
    remote: &str,
    stdin_data: Option<&[u8]>,
    connect_timeout: u64,
    op: &str,
) -> Result<String, String> {
    let mut cmd = new_command("ssh");
    push_ssh_opts(&mut cmd, "-p", settings, connect_timeout);
    cmd.arg("--").arg(ssh_target(settings));
    cmd.arg(remote);
    let output = run_command(cmd, stdin_data).await?;
    command_text(&output, "ssh", op)
}

static HOME_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

async fn remote_home(settings: &SshResolved, connect_timeout: u64) -> Result<String, String> {
    let key = format!("{}@{}:{}", settings.user, settings.host, settings.port);
    let cache = HOME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(home) = map.get(&key) {
            return Ok(home.clone());
        }
    }
    let home = ssh_exec(
        settings,
        r#"printf %s "$HOME""#,
        None,
        connect_timeout,
        "读取远端主目录",
    )
    .await?;
    let home = home.trim().to_string();
    if home.is_empty() || home.contains(['\n', '\r', ' ']) {
        return Err("无法读取远端主目录".into());
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(key, home.clone());
    }
    Ok(home)
}

fn split_http(raw: &str) -> Result<String, String> {
    const MARK: &str = "\n__PF_HTTP__";
    let Some((body, code)) = raw.rsplit_once(MARK) else {
        return Err(format!("MinerU 没有返回状态码：{}", clip(raw)));
    };
    let body = body.trim().to_string();
    let code: u16 = code.trim().parse().unwrap_or(0);
    if !(200..300).contains(&code) {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| clip(&body));
        return Err(format!("MinerU HTTP {code}：{message}"));
    }
    Ok(body)
}

fn curl_write_flag() -> &'static str {
    "\n__PF_HTTP__%{http_code}"
}

async fn local_request(
    socket: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    max_time: u64,
) -> Result<String, String> {
    let url = format!("http://mineru{path}");
    let mut cmd = new_command("curl");
    cmd.args([
        "-sS",
        "--max-time",
        &max_time.to_string(),
        "--unix-socket",
        socket,
        "-H",
        "Content-Type: application/json",
        "-X",
        method,
        "-w",
        curl_write_flag(),
        &url,
    ]);
    if body.is_some() {
        cmd.arg("--data-binary").arg("@-");
    }
    let output = run_command(cmd, body.map(str::as_bytes)).await?;
    let stdout = command_text(&output, "curl", "访问本地 MinerU 服务")?;
    split_http(&stdout)
}

async fn remote_request(
    settings: &SshResolved,
    method: &str,
    path: &str,
    body: Option<&str>,
    max_time: u64,
    connect_timeout: u64,
) -> Result<String, String> {
    let home = remote_home(settings, connect_timeout).await?;
    let socket = remote_socket(&settings.socket_path, &home)?;
    let data = if body.is_some() {
        " --data-binary @-"
    } else {
        ""
    };
    let url = format!("http://mineru{path}");
    let remote = format!(
        "curl -sS --max-time {max_time} --unix-socket {} -H {} -X {} {} -w {}{data}",
        quote_posix_remote_command(&socket),
        quote_posix_remote_command("Content-Type: application/json"),
        method,
        quote_posix_remote_command(&url),
        quote_posix_remote_command(curl_write_flag()),
    );
    let stdout = ssh_exec(
        settings,
        &remote,
        body.map(str::as_bytes),
        connect_timeout,
        "通过 SSH 请求 MinerU 服务",
    )
    .await?;
    split_http(&stdout)
}

fn remote_socket(socket_path: &str, home: &str) -> Result<String, String> {
    let socket = expand_remote_tilde(socket_path, home);
    if socket.contains(['\n', '\r', '\0']) {
        return Err("socket 路径无效".into());
    }
    Ok(socket)
}

async fn remote_get_many(
    settings: &SshResolved,
    paths: &[String],
    max_time: u64,
    connect_timeout: u64,
) -> Result<Vec<String>, String> {
    let home = remote_home(settings, connect_timeout).await?;
    let socket = remote_socket(&settings.socket_path, &home)?;
    let mut script = String::new();
    for (index, path) in paths.iter().enumerate() {
        let url = format!("http://mineru{path}");
        script.push_str(&format!("printf '%s\\n' __PF_ITEM_{index}\n"));
        script.push_str(&format!(
            "curl -sS --max-time {max_time} --unix-socket {} {} -w {}\n",
            quote_posix_remote_command(&socket),
            quote_posix_remote_command(&url),
            quote_posix_remote_command(curl_write_flag())
        ));
    }
    let raw = ssh_exec(
        settings,
        &script,
        None,
        connect_timeout,
        "通过 SSH 批量查询 MinerU 状态",
    )
    .await?;
    split_batch(&raw, paths.len())
}

/// 按 `__PF_ITEM_{i}` 标记切开批量输出，每段各自解析状态码。
fn split_batch(raw: &str, count: usize) -> Result<Vec<String>, String> {
    let mut bodies = Vec::with_capacity(count);
    for index in 0..count {
        let marker = format!("__PF_ITEM_{index}\n");
        let (_, rest) = raw
            .split_once(&marker)
            .ok_or_else(|| "MinerU 批量状态返回不完整".to_string())?;
        let item = if index + 1 < count {
            rest.split_once(&format!("__PF_ITEM_{}\n", index + 1))
                .map_or(rest, |(item, _)| item)
        } else {
            rest
        };
        bodies.push(split_http(item)?);
    }
    Ok(bodies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_tilde_uses_posix_separator() {
        assert_eq!(expand_remote_tilde("~", "/remote/home"), "/remote/home");
        assert_eq!(
            expand_remote_tilde("~/.mineru/doclib.sock", "/remote/home"),
            "/remote/home/.mineru/doclib.sock"
        );
        assert_eq!(
            expand_remote_tilde("/opt/doclib.sock", "/remote/home"),
            "/opt/doclib.sock"
        );
    }

    #[test]
    fn posix_remote_quoting_escapes_single_quotes() {
        assert_eq!(quote_posix_remote_command("plain"), "'plain'");
        assert_eq!(quote_posix_remote_command("a'b"), "'a'\\''b'");
    }

    #[test]
    fn inbox_dir_allowlist_rejects_shell_metacharacters() {
        for ok in ["~", "~/.mineru/paper-field-inbox", "/srv/mineru/inbox", "inbox", "/a/b~c/d-e_f.g/"] {
            assert!(valid_inbox_dir(ok), "{ok}");
        }
        for bad in [
            "",
            "~/x$(id)",
            "~/`id`",
            "/tmp/a;id",
            "/tmp/a|id",
            "/tmp/a&id",
            "/tmp/a b",
            "/tmp/'a'",
            "/tmp/\"a\"",
            "/tmp/a\nid",
            "/tmp/*",
            "/tmp/a>b",
            "~root/inbox",
            "~~/x",
            "-rf",
            "~/-x",
            "/srv/../etc",
            "~/..",
            "/tmp/收件箱",
        ] {
            assert!(!valid_inbox_dir(bad), "{bad:?}");
        }
        assert!(!valid_inbox_dir(&format!("/{}", "a".repeat(600))));
        // 展开后的路径同样要过白名单
        assert!(valid_inbox_dir(&expand_remote_tilde("~/.mineru/in", "/home/u")));
        assert!(!valid_inbox_dir(&expand_remote_tilde("~/in", "/home/$(id)")));
    }

    #[tokio::test]
    async fn upload_rejects_bad_inbox_before_running_anything() {
        let ssh = SshResolved {
            // 不可解析的主机：若校验漏过，会在 ssh 那一步失败而不是这里
            host: "invalid.invalid".into(),
            port: 22,
            user: "u".into(),
            identity: None,
            socket_path: "~/.mineru/doclib.sock".into(),
            inbox_dir: "~/in$(touch /tmp/pwned)".into(),
        };
        let err = DoclibTransport::Ssh(ssh).upload_pdf(Path::new("/nonexistent.pdf"), "x", 1).await.unwrap_err();
        assert_eq!(err, INBOX_RULE);
    }

    #[test]
    fn new_command_keeps_program() {
        for program in ["curl", "ssh", "scp"] {
            assert_eq!(new_command(program).as_std().get_program(), program);
        }
    }

    #[test]
    fn split_http_takes_last_status_mark_and_keeps_multibyte_body() {
        assert_eq!(split_http("{\"标题\":\"论文\"}\n__PF_HTTP__200").unwrap(), "{\"标题\":\"论文\"}");
        // 正文里出现同样的标记时以最后一个为准
        assert_eq!(split_http("a\n__PF_HTTP__x\n__PF_HTTP__201\n").unwrap(), "a\n__PF_HTTP__x");
        assert_eq!(
            split_http("{\"error\":{\"message\":\"文件不存在\"}}\n__PF_HTTP__404").unwrap_err(),
            "MinerU HTTP 404：文件不存在"
        );
        assert_eq!(split_http("中文\n__PF_HTTP__oops").unwrap_err(), "MinerU HTTP 0：中文");
        assert!(split_http("没有标记").unwrap_err().starts_with("MinerU 没有返回状态码"));
    }

    #[test]
    fn split_batch_cuts_items_by_marker() {
        let raw = "__PF_ITEM_0\n{\"状态\":\"done\"}\n__PF_HTTP__200__PF_ITEM_1\n{}\n__PF_HTTP__200";
        assert_eq!(split_batch(raw, 2).unwrap(), vec!["{\"状态\":\"done\"}".to_string(), "{}".to_string()]);
        assert_eq!(split_batch(raw, 0).unwrap(), Vec::<String>::new());
        assert_eq!(split_batch("__PF_ITEM_0\n{}\n__PF_HTTP__200", 2).unwrap_err(), "MinerU 批量状态返回不完整");
        assert!(split_batch("__PF_ITEM_0\n{}\n__PF_HTTP__500__PF_ITEM_1\n{}\n__PF_HTTP__200", 2)
            .unwrap_err()
            .starts_with("MinerU HTTP 500"));
    }

    #[test]
    fn ssh_auth_failure_needs_openssh_method_list() {
        assert!(is_ssh_auth_failure("user@host: Permission denied (publickey)."));
        assert!(is_ssh_auth_failure("Permission denied (gssapi-keyex,gssapi-with-mic,publickey,password)."));
        assert!(is_ssh_auth_failure("Permission denied, please try again."));
        assert!(!is_ssh_auth_failure("scp: /srv/inbox/a.pdf: Permission denied"));
        assert!(!is_ssh_auth_failure("curl: (7) Failed to connect to mineru port 80: Permission denied"));
        assert!(!is_ssh_auth_failure("Permission denied (os error 13)"));
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_is_attributed_to_the_failing_step() {
        use std::os::unix::process::ExitStatusExt;
        let failed = |stderr: &str| std::process::Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        };
        let login = "SSH 登录被拒绝，请检查用户和私钥";
        let denied = failed("u@h: Permission denied (publickey,password).");
        assert_eq!(command_text(&denied, "ssh", "读取远端主目录").unwrap_err(), login);
        assert_eq!(command_text(&denied, "scp", "上传 PDF 到远程暂存目录").unwrap_err(), login);

        let socket = failed("curl: (7) Failed to connect to mineru port 80 after 0 ms: Permission denied");
        let err = command_text(&socket, "curl", "访问本地 MinerU 服务").unwrap_err();
        assert!(err.starts_with("访问本地 MinerU 服务时权限不足："), "{err}");
        assert!(err.contains("curl: (7)") && !err.contains("SSH"), "{err}");
        // 本地 curl 输出里即便出现 ssh 样式也不算登录失败
        let err = command_text(&denied, "curl", "访问本地 MinerU 服务").unwrap_err();
        assert!(err.starts_with("访问本地 MinerU 服务时权限不足"), "{err}");

        let inbox = failed("scp: /srv/inbox/a.pdf: Permission denied");
        let err = command_text(&inbox, "scp", "上传 PDF 到远程暂存目录").unwrap_err();
        assert_eq!(err, "上传 PDF 到远程暂存目录时权限不足：scp: /srv/inbox/a.pdf: Permission denied");

        let mkdir = failed("mkdir: cannot create directory '/srv/inbox': Permission denied");
        let err = command_text(&mkdir, "ssh", "创建远程暂存目录").unwrap_err();
        assert!(err.starts_with("创建远程暂存目录时权限不足"), "{err}");

        assert_eq!(command_text(&failed(""), "ssh", "读取远端主目录").unwrap_err(), "读取远端主目录失败");

        let changed = failed(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
             @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
             Host key verification failed.",
        );
        assert_eq!(command_text(&changed, "ssh", "读取远端主目录").unwrap_err(), HOST_KEY_CHANGED);
        assert_eq!(command_text(&changed, "scp", "上传 PDF 到远程暂存目录").unwrap_err(), HOST_KEY_CHANGED);
        assert_eq!(command_text(&failed("Host key verification failed."), "ssh", "x").unwrap_err(), HOST_KEY_CHANGED);
        assert_eq!(command_text(&failed("boom"), "curl", "访问本地 MinerU 服务").unwrap_err(), "boom");
    }

    #[cfg(unix)]
    mod process {
        use std::fs;
        use std::time::{Duration, Instant};

        use super::super::*;

        #[tokio::test]
        async fn command_timeout_kills_child_process() {
            let started = Instant::now();
            let mut cmd = Command::new("sleep");
            cmd.arg("5");
            let err = tokio::time::timeout(Duration::from_secs(1), run_command(cmd, None))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("deadline"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(3));
        }

        #[tokio::test]
        async fn captured_output_is_capped() {
            let sh = |script: &str| {
                let mut cmd = Command::new("sh");
                cmd.arg("-c").arg(script);
                cmd
            };
            // stdout 超出上限：整个结果作废，但子进程照常结束（多余部分被读掉）
            let err = run_command_capped(sh("head -c 100000 /dev/zero"), None, 1000, 1000).await.unwrap_err();
            assert!(err.contains("输出超过"), "{err}");
            // stderr 超出只截断
            let out = run_command_capped(sh("head -c 100000 /dev/zero >&2; printf ok"), None, 1000, 1000)
                .await
                .unwrap();
            assert_eq!(out.stdout, b"ok");
            assert_eq!(out.stderr.len(), 1000);
            assert!(out.status.success());
            // 上限以内原样返回
            let out = run_command_capped(sh("printf hello"), None, 5, 5).await.unwrap();
            assert_eq!(out.stdout, b"hello");
        }

        #[tokio::test]
        async fn command_input_receives_eof_immediately() {
            let dir = crate::test_util::unique_temp_dir("paper-field-eof");
            let script = dir.join("fake-curl.sh");
            fs::write(&script, "#!/bin/sh\nexec cat\n").unwrap();

            let started = Instant::now();
            let output = tokio::time::timeout(
                Duration::from_secs(3),
                run_command(
                    {
                        // Run via `sh` instead of exec'ing the freshly written
                        // file: exec can fail with ETXTBSY when a parallel test
                        // forks while our write handle is still inherited.
                        let mut cmd = Command::new("sh");
                        cmd.arg(&script);
                        cmd
                    },
                    Some(b"hello-body"),
                ),
            )
            .await
            .unwrap();
            let output = output.unwrap();
            assert_eq!(command_text(&output, "sh", "测试命令").unwrap(), "hello-body");
            assert!(started.elapsed() < Duration::from_secs(2));
            fs::remove_dir_all(&dir).ok();
        }
    }
}
