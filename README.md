# Don-Bot — On-the-Run Dark Factory

A single-box, local-first autonomous software factory powered by `@earendil-works/pi-durable`, `@earendil-works/chord`, SQLite WAL (`node:sqlite`), `oxc.rs` (`oxlint`/`oxfmt`), and `huggingface/safeagents`.

- **Architecture & 5-Slice Roadmap:** See [SPEC.md](./SPEC.md)
- **Configuration Template:** See [don.config.example.yaml](./don.config.example.yaml)
- **Legacy `nod` Fork Reference:** Archived on branch `legacy/nod-reference`

## Quick Verification

```bash
bun install
bun run check
bun run test:crash
```
