# Don-Bot Architecture Deep Dive

Don-Bot is structured as a 6-package TypeScript/Bun monorepo (`packages/*`) paired with a standalone Rust security binary (`crates/don-guard`), backed by a single SQLite WAL file (`.don/factory.sqlite`) and isolated per-specialist `git worktree` checkouts.

---

## 1. Durable Execution Spine (`packages/spine`)

Don-Bot wraps `@earendil-works/pi-durable`, `@earendil-works/chord`, and Bun's native `node:sqlite` (`DatabaseSync`) in WAL mode:

- **Idempotent Side Effects (`once()` — [`packages/spine/src/events.ts`](../packages/spine/src/events.ts)):**
  - Before invoking an external side effect, `once(db, { memoKey, runId, replay }, fn)` atomically inspects `don_once_memos` inside a SQLite transaction.
  - Completed keys (`status = 'done'`) return `{ status: 'replayed', value }` without re-executing `fn()`.
  - If `SIGKILL` terminates the worker while `status = 'running'` and `replay = 'unsafe'`, restarting against the same WAL database marks the memo `'interrupted'`, records an audit event, and returns `InterruptedToolMessage` so the agent does not blindly duplicate external effects.
- **Turn Lock & Cancellation ([`packages/spine/src/turn-lock.ts`](../packages/spine/src/turn-lock.ts)):** `withTurnLock` and `withdrawTurn` ensure late or aborted owner turns fail closed across memory writes, outbound messages, and `DecisionCard` execution.
- **Compaction & Context Discipline ([`packages/spine/src/compact.ts`](../packages/spine/src/compact.ts)):** Tracks context window consumption at `10%` notice, `20%` warning, and `30%` forced lock where only `self_compact({ note_to_self })` is permitted until handoff completes.
- **Budget Circuit Breakers ([`packages/spine/src/budget.ts`](../packages/spine/src/budget.ts)):** Enforces `don_usage_ledger` spend caps (`$0.25` subagent, `70%` fast-tier downshift on `$2.00` task budget, `$15.00` daily cap), opening idempotent `budget_limit` `DecisionCard`s when crossed.
- **Time-Travel Checkpoints & Signed Rollbacks ([`packages/spine/src/replay.ts`](../packages/spine/src/replay.ts) · [`packages/spine/src/rollback.ts`](../packages/spine/src/rollback.ts)):** Captures step snapshots (`forkRunFromStep`) and HMAC-SHA256 signed git refs (`refs/don/rollbacks/rb-*`) tied to `don_events.seq`.

---

## 2. Hybrid Trust Boundary (`packages/trust` & `crates/don-guard`)

Don-Bot isolates security-critical primitives away from agent control flow:

### 2.1 Rust Security Worker (`crates/don-guard`)

Compiled binary [`crates/don-guard/src/main.rs`](../crates/don-guard/src/main.rs) serves 5 stdin/stdout JSON operations:

| Operation | Rust Module | Responsibility |
| :--- | :--- | :--- |
| `health` | [`sandbox.rs`](../crates/don-guard/src/sandbox.rs) | Reports active backend (`linux-bwrap-scrubbed` vs `linux-scrubbed-subprocess` / OS equivalent) |
| `ssrf-check` | [`ssrf.rs`](../crates/don-guard/src/ssrf.rs) | Rejects internal hostnames, loopback, RFC1918, Tailscale CGNAT (`100.64.0.0/10`), metadata (`169.254.0.0/16`), IPv6 ULA/link-local, IPv4-mapped IPv6, and NAT64 (`64:ff9b::/96`) |
| `vault-seal` / `vault-open` | [`vault.rs`](../crates/don-guard/src/vault.rs) | Performs `AES-256-GCM` encryption with `Zeroizing` key/plaintext buffers, JSON AAD binding (`[refId, name, kind]`), and Luhn credit-card PAN rejection |
| `exec` | [`sandbox.rs`](../crates/don-guard/src/sandbox.rs) | Runs `env_clear()` child processes (inside `bwrap` namespaces when permitted on Linux), enforces hard deadlines, and redacts secrets from stdout/stderr (`[REDACTED:VAULT]`) |

### 2.2 System-One Jev Calibrated Gates (`packages/trust`)

[`packages/trust/src/jev-client.ts`](../packages/trust/src/jev-client.ts) and [`packages/trust/src/trust-jev.ts`](../packages/trust/src/trust-jev.ts) integrate decision-modality APIs (`typesafe/jev-1.14` over OpenRouter, TypeSafe `jev-1.14.0`, or deterministic offline `createFauxJevClient`) with the ported 45-feature GBDT ensemble ([`packages/trust/src/trust-jev-model.json`](../packages/trust/src/trust-jev-model.json)):

1. **Tool Gate (`ToolTask.beforeTool`):** Enforces 24h Shadow Mode calibration on unseen mutating tools, verifies canonical JSON payload hashes for `always_allow`, validates active owner quotes (`quotedTurnId`), and fails closed after `1500 ms` timeouts or low confidence (`< 0.85`).
2. **Team Complexity Routing:** Routes simple tasks directly or escalates multi-lane tasks into 3-round `@mention` debate rooms.
3. **Top-Down Stop Verification:** Confirms diff & checks satisfy the goal without scope creep before completing a task.
4. **Memory Promotion Filter:** Guards long-term FTS5 memory persistence against unanchored rules.
5. **External Outbound Firewall:** Screens external Telegram and cross-factory mutating mailbox requests before delivery.

### 2.3 Skill Supply-Chain Evaluator ([`packages/trust/src/skill-evaluator.ts`](../packages/trust/src/skill-evaluator.ts))

Evaluates `SKILL.md` artifacts before workspace installation or Meta-Factory backporting — checking YAML schema, PII leaks, secret patterns, Unicode tag smuggling (`U+E0000` range), shell injection heuristics, and 6 target agent harnesses — storing signed verdicts in `don_skill_evals`. Automatically upgrades to Python `skillevaluator` CLI when installed.

---

## 3. Worktree Team & Top-Down Verification (`packages/team`)

[`packages/team/src/orchestrator.ts`](../packages/team/src/orchestrator.ts) models a strict separation of duties:

- **Roster (`canWriteCode=false` on Lead):** One Lead orchestrator routes tasks and owns the Decision Deck while four specialized builders (`api-keeper`, `pipeline-forge`, `client-qa`, `memory-curator`) work inside isolated `.don/worktrees/<task>-<role>` checkouts.
- **Debate Rooms & `@mention` Social Contract ([`packages/team/src/rooms.ts`](../packages/team/src/rooms.ts)):** Multi-lane tasks hold bounded `max_rounds = 3` discussions in SQLite before touching files.
- **Serialized `WriterLease` & `oxc.rs` Code Gate ([`packages/team/src/writer-lease.ts`](../packages/team/src/writer-lease.ts) · [`packages/team/src/code-gate.ts`](../packages/team/src/code-gate.ts)):** Merges back to the integration branch acquire an atomic SQLite lock and run `oxlint`, `oxfmt --check`, `tsc`, and `bun test`.
- **Top-Down Verifier & Dead-Letter Cooldown ([`packages/team/src/verifier.ts`](../packages/team/src/verifier.ts) · [`packages/team/src/cooldown.ts`](../packages/team/src/cooldown.ts)):** Validates atomic file/content claims + semantic Jev checks; after `2` execution failures or `3` verifier loops, moves the task to `blocked_needs_human` with a `dead_letter_cooldown` DecisionCard.

---

## 4. A2UI `v1.0` Cockpit, CDP Screencast & Telegram "Me" Mode (`packages/ui` · `packages/channels`)

- **Strict Custom Catalog ([`packages/ui/src/a2ui.ts`](../packages/ui/src/a2ui.ts)):** Agents cannot emit raw HTML/JS/CSS. Only `don.catalog.v1` JSON envelopes (`DecisionCard`, `BudgetGauge`, `CodeGateCard`, `SkillEvalCard`, `WorktreeLane`, `GuardAlert`, `RunTimeline`, `OutcomeReceipt`, `FactoryCard`, `FactoryChangelogCard`) pass `validateA2UISurface`.
- **$0.00-Token Macro Expander & SSE Stream ([`packages/ui/src/macros.ts`](../packages/ui/src/macros.ts) · [`packages/ui/src/server.ts`](../packages/ui/src/server.ts)):** Hydrates compact agent macro calls server-side from SQLite and pushes `dataModelUpdate` patches over authenticated SSE streams keyed by monotonic `events.seq`.
- **Headless Chromium CDP Screencast ([`packages/ui/src/cdp-stream.ts`](../packages/ui/src/cdp-stream.ts)):** Captures on-demand browser verification frames with `handbackAt` human takeover arbitration.
- **Telegram MTProto "Me" Mode ([`packages/channels/src/telegram.ts`](../packages/channels/src/telegram.ts) · [`packages/channels/src/firewall.ts`](../packages/channels/src/firewall.ts)):** Uses pure-JS/Bun `@mtcute/bun` (zero native C++ compilation), enforces `EXCLUSIONS.txt`, forbids forced `inviteToChannel`, and gates external messages on owner quotes or `👍` reactions in Saved Messages.

---

## 5. Level 4 Meta-Factory Fleet (`packages/meta`)

Coordinates multiple isolated Don-Bot workspaces under strict operator governance:

- **Blank Factory Templates & Skill Backports ([`packages/meta/src/templates.ts`](../packages/meta/src/templates.ts)):** Clones `don-core-v1`, validates backports with SkillEvaluator before proposing a `DecisionCard`, and persists versioned manifests.
- **Liquid Boundary ([`packages/meta/src/roles.ts`](../packages/meta/src/roles.ts)):** Allows declarative edits (`config.yaml`, `roster.yaml`, `skills/<slug>/SKILL.md`, `workflows/*.json`, `macros/*.json`) while blocking `.tsx`/`.jsx`/`.html`, `packages/ui`, `crates/don-guard`, `vault.ts`, and `ssrf.ts`. Every mutating `DecisionCard` enforces matching `expectedTaskId`, active owner-turn authorization, and single-use consumption.
- **Isolated Child Lifecycle & Mailbox ([`packages/meta/src/registry.ts`](../packages/meta/src/registry.ts) · [`packages/meta/src/mailbox.ts`](../packages/meta/src/mailbox.ts) · [`packages/meta/src/workflows.ts`](../packages/meta/src/workflows.ts)):** Graduates factories `empty -> operational` with 1:1 `FactoryOwner` stewards, rolls back skill files cleanly if upgrade commits fail, and secures cross-factory messaging behind `.don/access-key`, deterministic SSRF/exfil inspection, `<untrusted_tool_result>` wrapping, and Jev gates.
