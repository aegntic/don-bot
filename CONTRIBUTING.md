# Contributing to Don-Bot

Thank you for contributing to Don-Bot (`aegntic/don-bot`). Every change in this repository must uphold crash durability, fail-closed security gates, and zero-error `oxc.rs` / TypeScript hygiene.

---

## Prerequisites

- [Bun](https://bun.sh) `>= 1.4`
- Rust toolchain (`cargo`, `rustc` stable) for [`crates/don-guard`](./crates/don-guard/Cargo.toml)
- `git`
- Optional on Linux: `bubblewrap` (`bwrap`) for namespace isolation
- Optional: Python `skillevaluator` CLI (`don skills install`) and `safeagents` firewall (`don guard install`)

---

## Local Development Setup

```bash
git clone https://github.com/aegntic/don-bot.git
cd don-bot

# 1. Build and test the Rust security boundary first (required by Chaos Test 08)
cargo test --manifest-path crates/don-guard/Cargo.toml
cargo build --release --manifest-path crates/don-guard/Cargo.toml

# 2. Install TypeScript workspace dependencies & run full verification
bun install
bun run check
bun run test:crash
```

---

## Mandatory Pre-PR Verification Gate

Every PR must pass the exact commands executed by [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):

| Command | Checks |
| :--- | :--- |
| `cargo test --manifest-path crates/don-guard/Cargo.toml` | Rust SSRF, AES-256-GCM + `zeroize` Blind Vault, and sandbox env scrubbing tests |
| `cargo build --release --manifest-path crates/don-guard/Cargo.toml` | Native release binary used by `don-guard` integration tests |
| `bun run typecheck` | `tsc --noEmit` strict typechecking across `packages/*/src/**/*.ts` and `tests/**/*.ts` |
| `bun run lint` | `oxlint packages tests` with zero errors and zero warnings |
| `bun run fmt:check` | `oxfmt --check packages tests` formatting compliance |
| `bun test` | All co-located module unit tests (`packages/*/src/*.test.ts`), `tests/unit/`, and Chaos Tests `01–13` (`--faux`, `$0.00`) |
| `bun run test:crash` | Standalone real subprocess `SIGKILL` WAL crash-recovery proof |

Run `bun run fmt` before committing to auto-format TypeScript files per [`.oxfmtrc.json`](./.oxfmtrc.json).

---

## Monorepo Architecture Boundaries

When adding or editing modules, preserve package boundaries and security invariants documented in [`SPEC.md`](./SPEC.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md):

1. **`packages/trust` & `crates/don-guard`:** Never weaken SSRF blocks, secret scrubbing, `<untrusted_tool_result>` escaping, or fail-closed defaults.
2. **`packages/spine`:** External side effects must use `once()` memos (`events.ts`) and quote-anchored provenance (`memory.ts`, `turn-lock.ts`).
3. **`packages/team`:** Preserve Lead `canWriteCode = false`, serialized `WriterLease` merges, and Top-Down Verifier cooldown caps (`2` execution failures / `3` verifier loops).
4. **`packages/ui`:** Operator surfaces must strictly validate against `don.catalog.v1` (`validateA2UISurface`) with zero raw HTML/script injection.
5. **`packages/meta`:** Enforce `assertLiquidBoundary` (immutable runtime/UI/guard paths) and target-bound, single-use `DecisionCard` approvals before mutating fleet state.
6. **Tests first-class:** Add co-located `*.test.ts` (and/or `#[cfg(test)]` Rust tests) for unit logic plus chaos tests in `tests/chaos/` for multi-package invariants. Every test must run offline in `--faux` mode with zero live API keys.
