use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use zeroize::Zeroizing;

pub fn looks_like_payment_card(secret: &str) -> bool {
    let stripped: String = secret
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && *c != '-')
        .collect();
    if stripped.len() < 13 || stripped.len() > 19 || !stripped.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    let mut sum = 0u32;
    let mut double_it = false;
    for ch in stripped.chars().rev() {
        let mut digit = ch.to_digit(10).unwrap_or(0);
        if double_it {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double_it = !double_it;
    }
    sum % 10 == 0
}

pub fn decode_key(key_b64: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let raw = Zeroizing::new(
        STANDARD
            .decode(key_b64.trim())
            .map_err(|e| format!("Invalid base64 key: {e}"))?,
    );
    if raw.len() != 32 {
        return Err(format!("Expected 32-byte AES-256-GCM key, got {} bytes", raw.len()));
    }
    Ok(raw)
}

pub fn seal_secret(
    key: &Zeroizing<Vec<u8>>,
    binding: &[String],
    plaintext: &str,
) -> Result<String, String> {
    if looks_like_payment_card(plaintext) {
        return Err("Refusing to store payment card PAN inside Blind Vault (dev credentials only)".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Key init error: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let aad = serde_json::to_vec(binding).map_err(|e| format!("AAD serialize error: {e}"))?;
    let secret_bytes = Zeroizing::new(plaintext.as_bytes().to_vec());

    let encrypted = cipher
        .encrypt(
            nonce,
            Payload {
                msg: secret_bytes.as_slice(),
                aad: aad.as_slice(),
            },
        )
        .map_err(|e| format!("AES-256-GCM seal failed: {e}"))?;

    // Output layout matches legacy vault-crypto.ts: [12B nonce][ciphertext + 16B tag]
    let tag_start = encrypted.len().saturating_sub(16);
    let (ct, tag) = encrypted.split_at(tag_start);
    let mut packed = Vec::with_capacity(12 + 16 + ct.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(tag);
    packed.extend_from_slice(ct);
    Ok(STANDARD.encode(packed))
}

pub fn open_secret(
    key: &Zeroizing<Vec<u8>>,
    binding: &[String],
    ciphertext_b64: &str,
) -> Result<Zeroizing<String>, String> {
    let packed = STANDARD
        .decode(ciphertext_b64.trim())
        .map_err(|e| format!("Invalid ciphertext base64: {e}"))?;
    if packed.len() < 28 {
        return Err("Invalid encrypted payload length".to_string());
    }
    let nonce = Nonce::from_slice(&packed[0..12]);
    let tag = &packed[12..28];
    let ct = &packed[28..];
    let mut combined = Vec::with_capacity(ct.len() + 16);
    combined.extend_from_slice(ct);
    combined.extend_from_slice(tag);

    let aad = serde_json::to_vec(binding).map_err(|e| format!("AAD serialize error: {e}"))?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Key init error: {e}"))?;
    let decrypted = Zeroizing::new(
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: combined.as_slice(),
                    aad: aad.as_slice(),
                },
            )
            .map_err(|_| "AES-256-GCM authentication failed (wrong key or AAD binding)".to_string())?,
    );
    let text = String::from_utf8(decrypted.to_vec())
        .map_err(|e| format!("Decrypted secret is not UTF-8: {e}"))?;
    Ok(Zeroizing::new(text))
}

pub fn mask_secrets(input: &str, secrets: &[Zeroizing<String>]) -> String {
    let mut out = input.to_string();
    for secret in secrets {
        let s = secret.as_str();
        if s.len() >= 4 {
            out = out.replace(s, "[REDACTED:VAULT]");
        }
    }
    out
}
