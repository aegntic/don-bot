# Don-Bot Visual Workflows & Operational Playbook

<p align="center">
  <img src="../assets/card-01-hero-16x9.png" alt="Don-Bot Small Agent Team Roster and Core Capabilities" width="100%" />
</p>

End-to-end visual flowmaps showing how operators onboard, delegate multi-agent worktree tasks, tune per-role Core Four overrides, run durable cron jobs, operate the `~` Team Switcher cockpit, and govern Meta-Factory fleets in **`v0.6.0`**.

---

## 1. Zero-Friction Onboarding & `don-guard` Binary Discovery

```mermaid
flowchart LR
  Start["Run don onboard or don login openrouter"] --> Creds["Seal Credentials in SQLite (AES-256-GCM)"]
  Creds -->|"OpenRouter OAuth"| AutoJev["Auto-Activate System-One Jev (typesafe/jev-1.14)"]
  Creds -->|"Direct API Key (--key-stdin)"| ManualJev["Optional TYPESAFE_API_KEY or Local GBDT Fallback"]
  GuardInstall["Run scripts/install.sh (SHA-256 Verified)"] --> Detect["detectDonGuardBinary() Lookup Order"]
  Detect --> D1["1. DON_GUARD_BIN env var"]
  Detect --> D2["2. Workspace .don/bin/don-guard"]
  Detect --> D3["3. Home ~/.don/bin/don-guard"]
  Detect --> D4["4. Local cargo target/release + PATH"]
  AutoJev --> Ready["Workspace Operational (don status / don serve)"]
  ManualJev --> Ready
  D3 --> Ready
```

---

## 2. Solo vs. Multi-Agent Worktree Delegation & `--merge` Flowmap

![Don-Bot Multi-Agent Worktree Delegation and Writer Lease Merge Flow](../assets/diagrams/multi-agent-merge-flow.svg)

```mermaid
flowchart TD
  Goal["Operator: don team goal --merge"] --> Classify["classifyTaskComplexityWithJev()"]
  Classify -->|"Single-Lane Simple Goal"| Direct["Dispatch Coding Specialist Directly"]
  Classify -->|"Multi-Lane Complex Goal"| OpenRoom["Open SQLite Room (max_rounds=3) + Assign Lead"]
  OpenRoom --> LeadTurn["Lead Orchestrator (canWriteCode=false)"]
  LeadTurn -->|"delegate_to_specialist tool"| SpawnChild["Execute Child Specialist in .don/worktrees/task-role"]
  Direct --> SpawnChild
  SpawnChild --> Isolated["CodingTools + Symlinked node_modules + Isolated DB"]
  Isolated --> SkillGate["runSkillGate() (Tier 1-3 + 6-Harness)"]
  SkillGate -->|"Blocked in block mode"| ParkCard["Park Task + Open skill_eval_gate DecisionCard"]
  SkillGate -->|"Passed"| CodeGate["runCodeGate() (oxlint + oxfmt + tsc + bun test)"]
  CodeGate -->|"Failed & Attempts Remaining"| Repair["Auto-Repair Turn in Same Worktree (maxVerifierLoops=3)"]
  Repair --> CodeGate
  CodeGate -->|"Failed After 3 Loops"| Cooldown["Dead-Letter Cooldown (blocked_needs_human)"]
  CodeGate -->|"Passed + --merge"| CommitWT["commitWorktreeChanges() (Excludes .don/, node_modules, target)"]
  CommitWT --> WriterLease["Acquire .don/writer.lease.json -> mergeWorktreeIntoMain()"]
  WriterLease -->|"Conflict"| AbortClean["Abort Merge Safely · Keep Target Branch Clean"]
  WriterLease -->|"Clean --no-ff Merge"| Done["Updated Target Branch + Pruned Worktree · Push Blocked"]
```

---

## 3. Core Four Agentic Parity & Durable Cron Loop

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator / Lead Agent
  participant CF as core-four.ts (don_agent_overrides)
  participant CR as cron.ts (don_cron_jobs)
  participant Tick as Cockpit Background Ticker
  participant Budget as budget.ts (don_usage_ledger)

  Op->>CF: toggleAgentHarnessSlice(roleId, slice, enabled)
  alt roleId in [lead, memory-curator] and slice == coding
    CF-->>Op: FAIL CLOSED Error (non-coding invariant)
  else Valid Role Update
    CF->>CF: Persist override + append core_four event
    CF-->>Op: Return updated AgentCoreFourOverride
  end

  Op->>CR: createCronJob(name, schedule, prompt, roleId)
  CR-->>Op: Persisted job + next_run_at timestamp
  loop Every cronPollMs (default 30s)
    Tick->>CR: claimDueCronJobs(db, nowMs)
    CR-->>Tick: Atomic transaction updates next_run_at & marks running
    Tick->>Budget: getBudgetSnapshot(db, config)
    alt dailyUsd >= dailyMaxUsd or status == exceeded
      Tick->>CR: recordCronJobRun(id, "budget_paused", "Paused: cap reached")
    else Within Daily Cap
      Tick->>CR: recordCronJobRun(id, "done", summary)
    end
  end
```

---

## 4. A2UI `v1.0` Cockpit, `~` Team Switcher & Zero-LLM Telemetry

<p align="center">
  <img src="../assets/card-03-liquid-ui-16x9.png" alt="Don-Bot 3-Pane Liquid Software Interface" width="100%" />
</p>

![A2UI v1.0 3-Pane Cockpit and Tilde Team Switcher](../assets/diagrams/cockpit-core-four.svg)

```mermaid
sequenceDiagram
  autonumber
  participant Browser as PWA Cockpit Browser
  participant Auth as /api/auth/pair + .don/access-key
  participant API as packages/ui/src/server.ts
  participant Spine as BatchToolSummarizer & SQLite WAL

  Browser->>Auth: POST /api/auth/pair (Single-use DON-XXXXXX)
  Auth-->>Browser: Issue session access key (5m expiry)
  Browser->>API: GET /api/a2ui/surface (Bearer access-key)
  API-->>Browser: Validated don.catalog.v1 JSON (13 components)
  Browser->>API: GET /api/events (Last-Event-ID SSE stream)

  loop Every 3 Tool Calls
    Spine->>Spine: flush() secret-scrubbed summary -> don_tool_summaries
    Spine-->>API: Emit tool_summary event + monotonic seq
    API-->>Browser: SSE dataModelUpdate ($0.00 LLM push)
  end

  Note over Browser: Operator presses ~ (tilde) to filter lane or Steer
  Browser->>API: POST /api/team/core-four (toggle slice or tier)
  API->>Spine: Update don_agent_overrides + broadcast SSE event
  API-->>Browser: Refresh CoreFourCard live without page reload
```

---

## 5. Meta-Factory Fleet Governance & Cross-Factory Mailbox

```mermaid
flowchart TD
  Tpl["don-core-v1 Blank Template"] -->|"don template clone / factory spawn"| Empty["Empty Child Factory (Own WAL + Access Key)"]
  Empty -->|"don factory hire (Owner Turn + DecisionCard)"| Op["Operational Factory (1:1 FactoryOwner)"]
  Op -->|"Propose Skill Backport"| SkillCheck["Run SkillEvaluator (Tier 1-3) + assertLiquidBoundary()"]
  SkillCheck -->|"Touches packages/ui, crates/don-guard, .tsx/.html"| Block["HARD REJECT (Liquid Boundary Immutability)"]
  SkillCheck -->|"Declarative Path & Skill Passes"| Card["Open Target-Bound Single-Use DecisionCard"]
  Card -->|"don factory upgrade"| Upgrade["Atomic Upgrade + Rollback Checkpoint Guard"]
  Op <-->|"factory_mailbox_send / read"| MB["Jev + SSRF + untrusted_tool_result Mailbox Gate"]
```
