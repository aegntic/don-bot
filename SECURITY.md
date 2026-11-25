# Security Policy & Threat Model

Don-Bot is engineered around a **fail-closed, local-first security boundary**. No autonomous agent or external prompt payload is trusted with unguarded host execution, raw credentials, or unapproved external mutations.

---

## Defense-in-Depth Layers

| Layer | Enforcer | Source | Guarantee |
| :--- | :--- | :--- | :--- |
| **1 · Deterministic Tool Firewall & SSRF** | `inspectToolCallDeterministic`, `assertPublicUrl` | [`packages/trust/src/safeagents.ts`](./packages/trust/src/safeagents.ts) · [`packages/trust/src/ssrf.ts`](./packages/trust/src/ssrf.ts) | Blocks undeclared tools, `.env`/secret exfiltration paths, private RFC1918 networks, Tailscale CGNAT (`100.64.0.0/10`), cloud metadata (`169.254.0.0/16`), link-local IPv6, IPv4-mapped IPv6 (`::ffff:*`), and NAT64 (`64:ff9b::/96`). |
| **2 · Native Rust Security Boundary** | `don-guard` CLI worker (`stdin`/`stdout` JSON IPC) | [`crates/don-guard/src/main.rs`](./crates/don-guard/src/main.rs) · [`crates/don-guard/src/vault.rs`](./crates/don-guard/src/vault.rs) | Isolates AES-256-GCM Blind Vault cryptography (`zeroize` memory wiping), payment-card Luhn PAN rejection, host-bound `x-mcp-header` secret injection, env-scrubbed process spawning, and output secret masking (`[REDACTED:VAULT]`) outside the Bun/JS heap. |
| **3 · Calibrated System-One Jev + Shadow Mode** | `evaluateTrustGate`, 45-feature GBDT ensemble | [`packages/trust/src/trust-jev.ts`](./packages/trust/src/trust-jev.ts) · [`packages/trust/src/jev-client.ts`](./packages/trust/src/jev-client.ts) | Enforces 24-hour Shadow Mode calibration on unseen mutating tools, SHA-256 canonical JSON payload hashes for `always_allow` grants, live owner-turn verification (failing closed on `withdrawn` turns), and `1500 ms` fail-closed timeouts into Decision Deck cards. |
| **4 · Prompt Isolation & Operator Auth** | `<untrusted_tool_result>` escaping, `.don/access-key`, `withTurnLock` | [`packages/trust/src/untrusted.ts`](./packages/trust/src/untrusted.ts) · [`packages/trust/src/access-key.ts`](./packages/trust/src/access-key.ts) | Neutralizes closing-tag breakout injection in tool & mailbox outputs; gates `/api/*`, SSE, WS, and cross-factory mailbox calls behind timing-safe `.don/access-key` auth; enforces `<iframe sandbox="allow-scripts">` with zero-network CSP for untrusted previews. |
| **5 · Skill Supply-Chain & Liquid Boundary** | `runSkillEvaluator`, `assertLiquidBoundary`, single-use `DecisionCard`s | [`packages/trust/src/skill-evaluator.ts`](./packages/trust/src/skill-evaluator.ts) · [`packages/meta/src/roles.ts`](./packages/meta/src/roles.ts) | Scans skills across Tier 1 static/PII/Unicode-smuggling/6-harness checks before installation or template backport; forbids meta-level mutation of `packages/ui`, `crates/don-guard`, `vault.ts`, `ssrf.ts`, and `.tsx`/`.jsx`/`.html` sources; binds approval cards to exact target task IDs and single-use consumption. |

---

## OS Sandbox Capabilities (`crates/don-guard` & `packages/trust/src/sandbox.ts`)

- **Linux:** Wraps commands in `bubblewrap` (`bwrap --die-with-parent --new-session --proc /proc --dev /dev --tmpfs /tmp`) with read-only system mounts when `bwrap` user namespaces are permitted by the kernel, falling back honestly to `linux-scrubbed-subprocess` when restricted (for example in container/AppArmor runners). Both paths strip `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_PRIVATE_KEY`, and explicit tokens via `.env_clear()`.
- **macOS & Windows:** Uses git-worktree isolation plus scrubbed subprocess environments and `timeoutMs` hard process termination.

---

## What the Blind Vault Never Stores

`crates/don-guard/src/vault.rs` and `packages/trust/src/vault.ts` strictly reject:
- `kind: 'card'` secrets
- Numeric strings passing Luhn payment-card checksum validation (`13–19` digits), even when labeled as `staging_login` or `api_key`.

---

## Reporting a Vulnerability

If you discover a security bypass in SSRF validation, `don-guard`, Blind Vault AAD binding, A2UI payload validation, or Meta-Factory authorization:

1. **Do not** open a public issue with exploit payloads against live deployments.
2. Open a private security advisory on GitHub at [github.com/aegntic/don-bot/security/advisories](https://github.com/aegntic/don-bot/security/advisories) with:
   - Affected package/file and commit SHA
   - Minimal reproduction or failing unit/chaos test
   - Expected fail-closed invariant
3. Security fixes are verified with regression tests under `tests/chaos/` and co-located `*.test.ts` / Rust `#[cfg(test)]` suites before release.
