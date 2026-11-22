# Don-Bot — On-the-Run Dark Factory

A single-box, local-first autonomous software factory powered by `@earendil-works/pi-durable`, `@earendil-works/chord`, SQLite WAL (`node:sqlite`), `oxc.rs` (`oxlint`/`oxfmt`), and `huggingface/safeagents`.

> **Release Status:** Slice 01 (`v0.1.0-slice-01`) — Durable Spine, 4-Layer Trust Boundary, 1 Lead + 4 Specialist Worktree Team, and `don` CLI.

---

## 60-Second Quickstart (Linux / macOS / Windows)

**Requirements:**
- [Bun](https://bun.sh) `>= 1.4`
- `git`
- Optional on Linux: `bubblewrap` (`bwrap`) for kernel filesystem isolation
- Optional firewall sidecar: Hugging Face `safeagents` (`don guard install`)

```bash
git clone <your-repo-url> don-bot
cd don-bot
bun install
bun run check
bun run test:crash
```

`bun run test:crash` spends **$0.00**: it launches a real worker subprocess in `--faux` mode, sends `SIGKILL` mid-execution, restarts against the same SQLite WAL database, proves completed `once()` steps ran **exactly once**, and injects `InterruptedToolMessage` for unsafe interrupted steps.

---

## Single-Key BYOK & Workspace Onboarding

Set any **one** provider key in your environment — any unspecified model tier (`architect`, `workhorse`, `fast`, `gate`) automatically falls back to that provider's defaults:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY
```

Then initialize and run against any repository:

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
| `don run "<goal>" [--faux] [--role <id>]` | Run a single-lane task directly without opening a debate room |
| `don team "<goal>" [--faux] [--role <id>]` | Run complexity-gated Lead + Specialist orchestration (`api-keeper`, `pipeline-forge`, `client-qa`, `memory-curator`) |
| `don status [--dir <path>]` | Report SQLite WAL status, `safeagents` guard mode, budget caps, queue counts, and active worktrees |
| `don resume [--dir <path>]` | Inspect paused/interrupted tasks, incomplete `once()` memos, blocked cooldowns, and Decision Deck cards |
| `don guard <status\|block\|log-only\|install>` | Check, install, or switch `safeagents` mode cleanly in `.don/config.yaml` |
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

---

## 5-Slice Architecture Roadmap

| Slice | Scope | Status |
| :--- | :--- | :--- |
| **Slice 01** | Durable WAL Spine, 4-Layer Trust, 1 Lead + 4 Specialists, Worktrees, `oxc` Gate, `don` CLI | **Complete (`v0.1.0-slice-01`)** |
| **Slice 02** | Multi-turn live repo coding loop & remote runner integration | Planned |
| **Slice 03** | Rust `crates/don-guard` native OS sandbox + Trust-Jev owner-quote calibration | Planned |
| **Slice 04** | Telegram MTProto (`@mtcute/node`) operator channel (`packages/channels`) | Planned |
| **Slice 05** | Lean spring-liquid PWA Cockpit (`packages/ui`) + Decision Deck UI | Planned |

---

## References & Attribution

- Architecture & Invariants: [SPEC.md](./SPEC.md)
- Configuration Template: [don.config.example.yaml](./don.config.example.yaml)
- Apache-2.0 License & Port Attribution: [LICENSE](./LICENSE) · [NOTICE](./NOTICE)
- Legacy `n8n-io/nod` Fork Reference: Archived intact on git branch `legacy/nod-reference`
