use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

use crate::vault::mask_secrets;

const EXPLICIT_SECRET_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "DON_ACCESS_KEY",
    "NOD_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
    "TELEGRAM_API_HASH",
    "TELEGRAM_SESSION",
];

fn is_secret_env_name(name: &str) -> bool {
    if EXPLICIT_SECRET_KEYS.contains(&name) {
        return true;
    }
    let upper = name.to_ascii_uppercase();
    upper.ends_with("API_KEY")
        || upper.ends_with("_SECRET")
        || upper.ends_with("_TOKEN")
        || upper.ends_with("_PASSWORD")
        || upper.ends_with("PRIVATE_KEY")
}

pub fn os_sandbox_backend() -> &'static str {
    if cfg!(target_os = "linux") {
        if let Ok(lsm) = std::fs::read_to_string("/sys/kernel/security/lsm") {
            if lsm.contains("landlock") {
                return "linux-landlock-scrubbed";
            }
        }
        return "linux-scrubbed-subprocess";
    }
    if cfg!(target_os = "macos") {
        return "macos-seatbelt-ready";
    }
    if cfg!(target_os = "windows") {
        return "windows-jobobject-ready";
    }
    "generic-scrubbed"
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub sandbox_backend: String,
}

pub fn exec_sandboxed(
    command: &str,
    args: &[String],
    cwd: &str,
    timeout_ms: u64,
    inject_env: &HashMap<String, String>,
    extra_secrets: &[String],
) -> Result<ExecResult, String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();

    for (k, v) in std::env::vars() {
        if !is_secret_env_name(&k) {
            cmd.env(k, v);
        }
    }

    let mut mask_list: Vec<Zeroizing<String>> = extra_secrets
        .iter()
        .map(|s| Zeroizing::new(s.clone()))
        .collect();
    for (k, v) in inject_env {
        cmd.env(k, v);
        mask_list.push(Zeroizing::new(v.clone()));
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn \"{command}\" in \"{cwd}\": {e}"))?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(100));
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("Error waiting for sandbox child: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed collecting child output: {e}"))?;

    let raw_stdout = String::from_utf8_lossy(&output.stdout);
    let raw_stderr = String::from_utf8_lossy(&output.stderr);

    Ok(ExecResult {
        exit_code: output.status.code().unwrap_or(if timed_out { 124 } else { 1 }),
        stdout: mask_secrets(&raw_stdout, &mask_list),
        stderr: mask_secrets(&raw_stderr, &mask_list),
        timed_out,
        sandbox_backend: os_sandbox_backend().to_string(),
    })
}
