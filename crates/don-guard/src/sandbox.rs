use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
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

#[cfg(target_os = "linux")]
fn build_bwrap_system_args() -> Vec<String> {
    let mut args = vec![
        "--die-with-parent".to_string(),
        "--new-session".to_string(),
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
        "--tmpfs".to_string(),
        "/tmp".to_string(),
    ];
    for dir in ["/usr", "/bin", "/lib", "/lib64", "/etc"] {
        let Ok(meta) = std::fs::symlink_metadata(dir) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            if let Ok(target) = std::fs::read_link(dir) {
                args.push("--symlink".to_string());
                args.push(target.to_string_lossy().into_owned());
                args.push(dir.to_string());
            }
        } else if meta.is_dir() {
            args.push("--ro-bind".to_string());
            args.push(dir.to_string());
            args.push(dir.to_string());
        }
    }
    args
}

#[cfg(target_os = "linux")]
fn is_bwrap_usable() -> bool {
    static BWRAP_USABLE: OnceLock<bool> = OnceLock::new();
    *BWRAP_USABLE.get_or_init(|| {
        if !Path::new("/bin/true").exists() {
            return false;
        }
        let mut cmd = Command::new("bwrap");
        cmd.args(build_bwrap_system_args())
            .args(["--", "/bin/true"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.status().map(|s| s.success()).unwrap_or(false)
    })
}

#[cfg(not(target_os = "linux"))]
fn is_bwrap_usable() -> bool {
    false
}

pub fn os_sandbox_backend() -> &'static str {
    if cfg!(target_os = "linux") {
        if is_bwrap_usable() {
            return "linux-bwrap-scrubbed";
        }
        return "linux-scrubbed-subprocess";
    }
    if cfg!(target_os = "macos") {
        return "macos-scrubbed-subprocess";
    }
    if cfg!(target_os = "windows") {
        return "windows-scrubbed-subprocess";
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
    let backend = os_sandbox_backend();
    let mut cmd = if cfg!(target_os = "linux") && backend == "linux-bwrap-scrubbed" {
        #[cfg(target_os = "linux")]
        {
            let mut bwrap = Command::new("bwrap");
            bwrap
                .args(build_bwrap_system_args())
                .args(["--bind", cwd, cwd, "--chdir", cwd, "--", command])
                .args(args);
            bwrap
        }
        #[cfg(not(target_os = "linux"))]
        {
            let mut direct = Command::new(command);
            direct.args(args);
            direct
        }
    } else {
        let mut direct = Command::new(command);
        direct.args(args);
        direct
    };

    cmd.current_dir(cwd)
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
        sandbox_backend: backend.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_secret_environment_variable_names() {
        assert!(is_secret_env_name("ANTHROPIC_API_KEY"));
        assert!(is_secret_env_name("custom_api_key"));
        assert!(is_secret_env_name("SERVICE_TOKEN"));
        assert!(is_secret_env_name("DB_PASSWORD"));
        assert!(is_secret_env_name("DEPLOY_PRIVATE_KEY"));
        assert!(is_secret_env_name("OAUTH_CLIENT_SECRET"));
        assert!(!is_secret_env_name("PATH"));
        assert!(!is_secret_env_name("HOME"));
    }

    #[cfg(unix)]
    #[test]
    fn scrubs_secrets_masks_stdout_and_enforces_timeout() {
        let unique = format!(
            "don-guard-sandbox-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();

        let mut inject = HashMap::new();
        inject.insert("INJECTED_SECRET".to_string(), "tok_super_secret_1234".to_string());
        let extra = vec!["extra_secret_xyz987".to_string()];

        let res = exec_sandboxed(
            "/bin/sh",
            &[
                "-c".to_string(),
                "echo \"INJ=$INJECTED_SECRET EXTRA=extra_secret_xyz987\"".to_string(),
            ],
            &cwd,
            5_000,
            &inject,
            &extra,
        )
        .unwrap();

        assert_eq!(res.exit_code, 0);
        assert!(!res.timed_out);
        assert!(res.stdout.contains("INJ=[REDACTED:VAULT]"));
        assert!(res.stdout.contains("EXTRA=[REDACTED:VAULT]"));
        assert!(!res.stdout.contains("tok_super_secret_1234"));

        let timed = exec_sandboxed(
            "/bin/sh",
            &["-c".to_string(), "sleep 2".to_string()],
            &cwd,
            120,
            &HashMap::new(),
            &[],
        )
        .unwrap();
        assert!(timed.timed_out);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn scrubs_secrets_and_masks_stdout_on_windows() {
        let unique = format!(
            "don-guard-sandbox-win-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();

        let parent_secret_var = "DON_WIN_TEST_API_KEY";
        assert!(is_secret_env_name(parent_secret_var));
        std::env::set_var(parent_secret_var, "parent_secret_should_be_scrubbed");

        let scrub_res = exec_sandboxed(
            "cmd.exe",
            &[
                "/C".to_string(),
                "if defined DON_WIN_TEST_API_KEY (echo LEAKED) else (echo SCRUBBED)".to_string(),
            ],
            &cwd,
            5_000,
            &HashMap::new(),
            &[],
        )
        .unwrap();

        std::env::remove_var(parent_secret_var);

        assert_eq!(scrub_res.exit_code, 0);
        assert!(!scrub_res.timed_out);
        assert!(scrub_res.stdout.contains("SCRUBBED"));
        assert!(!scrub_res.stdout.contains("LEAKED"));
        assert!(!scrub_res.stdout.contains("parent_secret_should_be_scrubbed"));

        let mut inject = HashMap::new();
        inject.insert("INJECTED_SECRET".to_string(), "tok_super_secret_1234".to_string());
        let extra = vec!["extra_secret_xyz987".to_string()];

        let mask_res = exec_sandboxed(
            "cmd.exe",
            &[
                "/C".to_string(),
                "echo INJ=%INJECTED_SECRET% EXTRA=extra_secret_xyz987".to_string(),
            ],
            &cwd,
            5_000,
            &inject,
            &extra,
        )
        .unwrap();

        assert_eq!(mask_res.exit_code, 0);
        assert!(!mask_res.timed_out);
        assert!(mask_res.stdout.contains("INJ=[REDACTED:VAULT]"));
        assert!(mask_res.stdout.contains("EXTRA=[REDACTED:VAULT]"));
        assert!(!mask_res.stdout.contains("tok_super_secret_1234"));
        assert!(!mask_res.stdout.contains("extra_secret_xyz987"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
