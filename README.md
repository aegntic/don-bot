# Don-Bot — On-the-Run Dark Factory

A single-box, local-first autonomous software factory powered by `@earendil-works/pi-durable`, `@earendil-works/chord`, SQLite WAL (`node:sqlite`), `oxc.rs` (`oxlint`/`oxfmt`), `huggingface/safeagents`, and [NVIDIA/SkillEvaluator](https://github.com/NVIDIA/SkillEvaluator).

> **Latest Release (`v0.6.0` on `main`):** Slices 01–06 are live at [github.com/aegntic/don-bot/releases/tag/v0.6.0](https://github.com/aegntic/don-bot/releases/tag/v0.6.0) and [don.aegntic.ai](https://don.aegntic.ai) (Durable Spine, 4-Layer Trust + Rust `don-guard` + System-One Jev + Blind Vault, Core SkillEvaluator Gate, Full Worktree Team + Top-Down Verifier, `@mtcute/bun` Telegram "Me" Mode, OAuth-First Onboarding, A2UI `v1.0` 3-Pane PWA Cockpit + Chromium CDP Screencast, and Meta-Factory Fleet Orchestration). Release `v0.1.0-slice-01` preserves the initial Slice 01 baseline.

---

## 60-Second Quickstart (Linux / macOS / Windows)

**Requirements:**
- [Bun](https://bun.sh) `>= 1.4`
- `git`
- Optional on Linux: `bubblewrap` (`bwrap`) for kernel filesystem isolation
- Optional firewall sidecar: Hugging Face `safeagents` (`don guard install`)

```bash
git clone https://github.com/aegntic/don-bot.git don-bot
cd don-bot
bun install
bun run check
bun run test:crash
```

`bun run test:crash` spends **$0.00**: it launches a real worker subprocess in `--faux` mode, sends `SIGKILL` mid-execution, restarts against the same SQLite WAL database, proves completed `once()` steps ran **exactly once**, and injects `InterruptedToolMessage` for unsafe interrupted steps.

---

## Zero-Friction OAuth & Key Onboarding

Run the guided wizard once per workspace — **one OpenRouter OAuth login** (`don login openrouter`) automatically activates all 4 LLM tiers **and** live System-One Jev (`typesafe/jev-1.14`), sealing all secrets encrypted inside SQLite (`don_provider_credentials` via `don-guard` / `AES-256-GCM`):

```bash
bun run don onboard --dir /path/to/your-repo      # Guided interactive setup (OAuth / masked keys / Telegram Blind Vault)
bun run don login openrouter                      # Direct 1-click OAuth PKCE (or: anthropic, openai, openai-codex, github-copilot)
bun run don serve --dir /path/to/your-repo        # Prints a 5-min single-use pairing code (DON-XXXXXX) for the browser Cockpit
```

Or continue using any **one** ambient environment key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`) and run:

```bash
bun run don init --dir /path/to/your-repo
bun run don status --dir /path/to/your-repo
bun run don team "Add healthcheck endpoint and unit test" --dir /path/to/your-repo --faux
```

---

## `don` CLI Reference

| Command | Purpose |
| :--- | :--- |
| `don init [--dir <path>]` | Create `.don/factory.sqlite` (WAL), `.don/config.yaml`, `.don/access-key`, and `.don/.gitignore` |
| `don onboard [--dir <path>] [--non-interactive]` | Guided setup for OAuth AI brain (`openrouter`/`claude`/`chatgpt`/`copilot`), System-One Jev & Telegram Blind Vault |
| `don login [provider] [--dir <path>]` | Run built-in OAuth PKCE / Device Code sign-in (`openrouter` default unlocks AI + Jev) |
| `don auth <status\|set\|logout>` | Inspect, encrypt into SQLite, or remove provider credentials without echoing secrets |
| `don run "<goal>" [--faux] [--role <id>]` | Run a single-lane task directly without opening a debate room |
| `don team "<goal>" [--faux] [--role <id>]` | Run complexity-gated Lead + Specialist orchestration (`api-keeper`, `pipeline-forge`, `client-qa`, `memory-curator`) |
| `don status [--dir <path>]` | Report SQLite WAL status, `safeagents` guard mode, budget caps, queue counts, and active worktrees |
| `don serve [--port <n>] [--host <addr>]` | Start the authenticated A2UI `v1.0` / SSE 3-pane Liquid PWA Cockpit server (`127.0.0.1:4321`) + short `DON-XXXXXX` pairing code |
| `don resume [--dir <path>]` | Inspect paused/interrupted tasks, incomplete `once()` memos, blocked cooldowns, and Decision Deck cards |
| `don guard <status\|rust-status\|jev-status\|block\|log-only\|install>` | Check `safeagents`, compiled Rust `don-guard`, or Jev System-One config & toggle guard mode |
| `don vault <set\|list>` | Store or list host-bound AES-256-GCM Blind Vault credentials (never echoes secret plaintext) |
| `don rollback <create\|list>` | Create or list HMAC-SHA256 signed git worktree + SQLite rollback checkpoints |
| `don channel status` | Inspect `@mtcute/bun` Telegram "Me" Mode driver, `EXCLUSIONS.txt`, and tunnel tools |
| `don tunnel <tailscale\|cloudflared>` | Print zero-port remote access command (`tailscale serve` / `cloudflared`) and detect binaries |
| `don skills <status\|eval\|harness\|history\|block\|log-only\|install>` | Run core NVIDIA SkillEvaluator checks, 6-harness checks, history, and gate mode |
| `don template <list\|clone>` | List or clone versioned Blank Factory Templates (`don-core-v1`) |
| `don factory <list\|spawn\|hire\|upgrade\|audit\|changelog\|archive\|mailbox>` | Manage Meta-Factory child workspaces, 1:1 owners, upgrades, and Jev-gated mailbox |
| `don worktree gc [--dir <path>]` | Prune merged or orphaned `.don/worktrees/*` checkouts and clean `don/*` branches |
| `don test:crash` | Run Chaos Test 1 (`SIGKILL` + `once()` recovery) |

---

## `safeagents` Guard Setup

New `.don/config.yaml` files start in `log-only` mode so initial onboarding never breaks local exploration. Switch to active interception when ready:

```bash
bun run don guard install
bun run don guard status
bun run don guard block --dir /path/to/your-repo
```

---

## Core `NVIDIA/SkillEvaluator` Gate Setup

Don-Bot runs a built-in zero-dependency Tier 1 static, security, PII, Unicode smuggling, and 6-harness evaluator out of the box, and automatically upgrades to the full Python [`NVIDIA/SkillEvaluator`](https://github.com/NVIDIA/SkillEvaluator) CLI (Tier 1/2/3 + Harbor) when installed:

```bash
bun run don skills install
bun run don skills status --dir /path/to/your-repo
bun run don skills eval --dir /path/to/your-repo
bun run don skills harness --dir /path/to/your-repo
```

---

## OS Notes

- **Linux:** `SandboxPort` uses `bwrap` (`bubblewrap`) when available and automatically strips `*_API_KEY`, `*_TOKEN`, and `DON_ACCESS_KEY` from child environments.
- **macOS & Windows:** Uses isolated worktrees (`createSpecialistWorktree`, Windows directory junctions via `node:fs` where supported), stripped child environments, `node:sqlite` WAL storage, and `node:path` separators throughout.

---

## CI Chaos Tests (`--faux`, Zero Live API Keys)

| Test File | What It Proves |
| :--- | :--- |
| `tests/chaos/01-sigkill-replay.test.ts` | Real child-process `SIGKILL` recovery via SQLite WAL + `once()` |
| `tests/chaos/02-forced-compaction.test.ts` | `>=30%` forced `self_compact` tool-lock + `note_to_self` handoff |
| `tests/chaos/03-prompt-injection-safeagents.test.ts` | `<untrusted_tool_result>` escaping, `safeagents` blocks, SSRF & `.env` guards |
| `tests/chaos/04-worktree-merge-lease.test.ts` | Parallel worktrees, serialized writer lease, `oxc.rs` code gate, `@mention` rooms & cooldown |
| `tests/chaos/05-budget-circuit-breaker.test.ts` | `70%` fast-tier downshift + `$2.00` task / `$0.25` subagent circuit breakers |
| `tests/chaos/06-skill-evaluator-gate.test.ts` | Core SkillEvaluator Tier 1 + 6-harness checks, Decision Deck escalation, push guard & CLI contract |
| `tests/chaos/07-slice02-verifier-replay.test.ts` | Complexity-gated 3-round debate rooms, Top-Down Verifier loop, subagent guards & step replay fork |
| `tests/chaos/08-slice03-don-guard-jev-vault.test.ts` | Compiled Rust `don-guard` binary, Blind Vault `AES-256-GCM`, `trust-jev` Shadow Mode & signed rollbacks |
| `tests/chaos/09-slice04-telegram-firewall.test.ts` | `@mtcute/bun` native SQLite, two-zone outbound firewall, `EXCLUSIONS.txt`, Inline Buttons & STT routing |
| `tests/chaos/10-slice05-a2ui-cockpit.test.ts` | A2UI `v1.0` `don.catalog.v1`, TS Macro Expander, `.don/access-key` SSE, Preview CSP & headless Chromium CDP |
| `tests/chaos/11-jev-system-one-agents.test.ts` | Live Jev wire protocol (`typesafe`/`openrouter`/`openai`), 45-feature GBDT ensemble, and 5 factory Jev gates |
| `tests/chaos/12-onboarding-oauth-vault.test.ts` | Encrypted `VaultCredentialStore`, 1-login OpenRouter OAuth (+ auto-Jev), single-use Cockpit pairing codes & CLI auth lifecycle |
| `tests/chaos/13-slice06-meta-factory.test.ts` | Meta-Factory template cloning, Liquid Boundary, SkillEvaluator backport gate, 3-state fleet lifecycle, Jev mailbox & heartbeat |

---

## 6-Slice Architecture Roadmap

| Slice | Scope | Status |
| :--- | :--- | :--- |
| **Slice 01** | Durable WAL Spine, 4-Layer Trust, 1 Lead + 4 Specialists, Worktrees, `oxc` Gate, `don` CLI | **Complete (`v0.1.0-slice-01` · `main`)** |
| **Slice 02** | 3-round debate rooms, Top-Down Verifier loop, subagent privilege stripping & time-travel fork | **Complete (`main`)** |
| **Slice 03** | Rust `crates/don-guard` native OS sandbox + `trust-jev` owner-quote calibration & Blind Vault | **Complete (`main`)** |
| **Slice 04** | Telegram MTProto (`@mtcute/bun@0.32.8`, zero C++ builds) operator channel (`packages/channels`) | **Complete (`main`)** |
| **Slice 05** | **A2UI 1.0** Custom Catalog (`don.catalog.v1`) + TypeScript Macro Hydration + 3-Pane PWA Cockpit (`packages/ui`) | **Complete (`main`)** |
| **Slice 06** | **Meta-Factory Fleet (`packages/meta`)**: blank templates, SkillEvaluator backports, 1:1 `FactoryOwner` & Jev-gated mailbox | **Complete (`main`)** |

---

## References & Attribution

- Architecture & Invariants: [SPEC.md](./SPEC.md)
- Configuration Template: [don.config.example.yaml](./don.config.example.yaml)
- Apache-2.0 License & Port Attribution: [LICENSE](./LICENSE) · [NOTICE](./NOTICE)
- Legacy `n8n-io/nod` Fork Reference: Archived intact on git branch `legacy/nod-reference`
