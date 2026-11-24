mod sandbox;
mod ssrf;
mod vault;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum GuardRequest {
    Health,
    SsrfCheck {
        url: String,
        #[serde(default)]
        ips: Option<Vec<String>>,
    },
    VaultSeal {
        #[serde(rename = "keyB64")]
        key_b64: String,
        binding: Vec<String>,
        plaintext: String,
    },
    VaultOpen {
        #[serde(rename = "keyB64")]
        key_b64: String,
        binding: Vec<String>,
        ciphertext: String,
    },
    Exec {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: String,
        #[serde(rename = "timeoutMs", default = "default_timeout_ms")]
        timeout_ms: u64,
        #[serde(rename = "injectEnv", default)]
        inject_env: HashMap<String, String>,
        #[serde(rename = "maskSecrets", default)]
        mask_secrets: Vec<String>,
    },
}

fn default_timeout_ms() -> u64 {
    60_000
}

#[derive(Serialize)]
struct GuardResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    addresses: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plaintext: Option<String>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr: Option<String>,
    #[serde(rename = "timedOut", skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl GuardResponse {
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            backend: None,
            addresses: None,
            ciphertext: None,
            plaintext: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            timed_out: None,
            error: Some(msg.into()),
        }
    }
}

fn handle_request(req: GuardRequest) -> GuardResponse {
    match req {
        GuardRequest::Health => GuardResponse {
            ok: true,
            backend: Some(sandbox::os_sandbox_backend().to_string()),
            addresses: None,
            ciphertext: None,
            plaintext: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            timed_out: None,
            error: None,
        },
        GuardRequest::SsrfCheck { url, ips } => {
            let parsed_ips = match ips {
                Some(list) => {
                    let mut out = Vec::with_capacity(list.len());
                    for raw in list {
                        match raw.parse::<IpAddr>() {
                            Ok(ip) => out.push(ip),
                            Err(e) => return GuardResponse::err(format!("Invalid IP \"{raw}\": {e}")),
                        }
                    }
                    Some(out)
                }
                None => None,
            };
            match ssrf::check_url(&url, parsed_ips.as_deref()) {
                Ok(addrs) => GuardResponse {
                    ok: true,
                    backend: None,
                    addresses: Some(addrs),
                    ciphertext: None,
                    plaintext: None,
                    exit_code: None,
                    stdout: None,
                    stderr: None,
                    timed_out: None,
                    error: None,
                },
                Err(e) => GuardResponse::err(e),
            }
        }
        GuardRequest::VaultSeal {
            key_b64,
            binding,
            plaintext,
        } => {
            let key = match vault::decode_key(&key_b64) {
                Ok(k) => k,
                Err(e) => return GuardResponse::err(e),
            };
            let secret = Zeroizing::new(plaintext);
            match vault::seal_secret(&key, &binding, &secret) {
                Ok(ct) => GuardResponse {
                    ok: true,
                    backend: Some("rust-aes-256-gcm-zeroize".to_string()),
                    addresses: None,
                    ciphertext: Some(ct),
                    plaintext: None,
                    exit_code: None,
                    stdout: None,
                    stderr: None,
                    timed_out: None,
                    error: None,
                },
                Err(e) => GuardResponse::err(e),
            }
        }
        GuardRequest::VaultOpen {
            key_b64,
            binding,
            ciphertext,
        } => {
            let key = match vault::decode_key(&key_b64) {
                Ok(k) => k,
                Err(e) => return GuardResponse::err(e),
            };
            match vault::open_secret(&key, &binding, &ciphertext) {
                Ok(plain) => GuardResponse {
                    ok: true,
                    backend: Some("rust-aes-256-gcm-zeroize".to_string()),
                    addresses: None,
                    ciphertext: None,
                    plaintext: Some(plain.to_string()),
                    exit_code: None,
                    stdout: None,
                    stderr: None,
                    timed_out: None,
                    error: None,
                },
                Err(e) => GuardResponse::err(e),
            }
        }
        GuardRequest::Exec {
            command,
            args,
            cwd,
            timeout_ms,
            inject_env,
            mask_secrets,
        } => match sandbox::exec_sandboxed(&command, &args, &cwd, timeout_ms, &inject_env, &mask_secrets) {
            Ok(res) => GuardResponse {
                ok: res.exit_code == 0 && !res.timed_out,
                backend: Some(res.sandbox_backend),
                addresses: None,
                ciphertext: None,
                plaintext: None,
                exit_code: Some(res.exit_code),
                stdout: Some(res.stdout),
                stderr: Some(res.stderr),
                timed_out: Some(res.timed_out),
                error: None,
            },
            Err(e) => GuardResponse::err(e),
        },
    }
}

fn main() {
    let mut input = String::new();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json_text = if args.first().map(|s| s.as_str()) == Some("--health") {
        r#"{"op":"health"}"#.to_string()
    } else {
        if let Err(e) = std::io::stdin().read_to_string(&mut input) {
            let resp = GuardResponse::err(format!("Failed reading stdin: {e}"));
            println!("{}", serde_json::to_string(&resp).unwrap_or_default());
            std::process::exit(1);
        }
        input
    };

    let parsed: GuardRequest = match serde_json::from_str(&json_text) {
        Ok(r) => r,
        Err(e) => {
            let resp = GuardResponse::err(format!("Invalid JSON request: {e}"));
            println!("{}", serde_json::to_string(&resp).unwrap_or_default());
            std::process::exit(1);
        }
    };

    let resp = handle_request(parsed);
    let ok = resp.ok;
    println!("{}", serde_json::to_string(&resp).unwrap_or_default());
    if !ok {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    #[test]
    fn blocks_tailscale_metadata_nat64_and_rfc1918() {
        let blocked = [
            ("http://127.0.0.1:8787/", vec!["127.0.0.1"]),
            ("https://ts.example/", vec!["100.64.0.12"]),
            ("http://169.254.169.254/latest/meta-data/", vec!["169.254.169.254"]),
            ("https://rfc.example/", vec!["192.168.1.10"]),
            ("https://nat64.example/", vec!["64:ff9b::10.0.0.5"]),
            ("https://v6map.example/", vec!["::ffff:127.0.0.1"]),
        ];
        for (url, ips) in blocked {
            let parsed: Vec<IpAddr> = ips.iter().map(|s| s.parse().unwrap()).collect();
            assert!(ssrf::check_url(url, Some(&parsed)).is_err(), "expected SSRF block for {url}");
        }
        let pub_ips: Vec<IpAddr> = vec!["140.82.121.6".parse().unwrap()];
        assert!(ssrf::check_url("https://api.github.com/zen", Some(&pub_ips)).is_ok());
    }

    #[test]
    fn seals_opens_and_rejects_tamper_and_payment_cards() {
        let key_b64 = STANDARD.encode([7u8; 32]);
        let key = vault::decode_key(&key_b64).unwrap();
        let binding = vec!["github".to_string(), "token".to_string()];

        let ct = vault::seal_secret(&key, &binding, "ghp_realTestToken1234567890").unwrap();
        let opened = vault::open_secret(&key, &binding, &ct).unwrap();
        assert_eq!(opened.as_str(), "ghp_realTestToken1234567890");

        let wrong_binding = vec!["other".to_string()];
        assert!(vault::open_secret(&key, &wrong_binding, &ct).is_err());

        // Standard Luhn test PAN must be rejected by Blind Vault
        assert!(vault::seal_secret(&key, &binding, "4111-1111-1111-1111").is_err());
    }
}
