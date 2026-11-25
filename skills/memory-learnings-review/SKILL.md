---
name: memory-learnings-review
description: Reviews what was found and learned in the current session (bugs, wrong assumptions, user corrections, wasted time, surprising facts) and curates them into the right destination (project/global/openchamber memory, or a skill/rule/script update), rejecting noise. Also runs compaction/pruning passes to merge duplicates and remove stale entries. Use when the user asks to save learnings, update memory, do a retrospective, "what should we remember", "compact memory", "prune memory", or after a long debugging or review session.
---

# Memory Learnings Review

Turn a session's findings into a small number of high-value, deduplicated entries routed to the right destination — and prefer saving *nothing* over saving noise.

Also supports a **Compaction Mode** (below) to merge duplicates, surface bloat, and prune stale entries.

## Review Process

### 1. Collect candidates (including staged items)

First, call `memory_search` with no arguments to inspect the active stores (project, global, and OpenChamber if present) and check `_staging.md` for any candidates parked earlier in this or prior sessions.

Then scan the conversation for:
- Mistakes made by the agent or the code, and what actually caused them (only causes that were verified).
- User corrections or stated preferences.
- Time sinks: where effort was wasted and what would have avoided it.
- Facts about systems, tooling, or the environment that were surprising and verified.
- Fixes that passed review or tests for the wrong reason.

List each candidate as one sentence with its evidence (ticket, PR, command output). Drop any candidate without evidence from this session or `_staging.md`.

### 2. Apply the value test

Keep a candidate only if every answer is yes:
1. Generic: useful beyond this one ticket, or a project fact a future session would need.
2. Non-obvious: not something a competent engineer or the model would do anyway.
3. Evidence-backed: observed in this session, not speculated. If the cause is only a hypothesis, record it as uncertain or skip it.
4. Actionable: statable as a rule, check, or fact that changes what to do next time.
5. Not derivable from the code, git history, or ticket text.
6. Not already stored (see step 3).

Cap a run at 8 entries. If more pass, keep the 8 with the highest cost-of-ignorance.

### 3. Deduplicate against memory

Use `memory_search` (with keywords and/or `file` to read full topic files) across all active stores — do not assume a hardcoded directory path, since the store may be in fork-store mode, explicit `memoryDirs`, `globalDir`, or `openchamberDir`.

If an existing entry already says it, skip. If an entry is close but missing the new nuance, write one new bullet that adds only the nuance and names what it refines. If an entry is contradicted by the new evidence, tell the user instead of silently adding a conflicting bullet.

### 4. Route to the right destination and write

Before writing a memory bullet, check whether the lesson actually belongs somewhere stronger than memory:
- **Skill / instruction / script / lint rule**: if a recurring pitfall is caused by an outdated skill, missing script check, or broken instruction, propose editing that file directly (and ask before modifying it) rather than piling up another memory bullet.
- **Project memory** (default `memory_note`): repo, service, architecture, or tooling facts specific to this project (`30-<project>-context.md` or a focused `40-<topic>.md`).
- **Global memory** (`memory_note` with `global: true`): cross-project rules that apply everywhere:
  - Execution and verification rules: `10-general-execution-rules.md`
  - Test-writing rules: `11-tdd-default-workflow.md`
  - Debugging method and gotchas: `12-debugging-and-validation-ladder.md`
  - Operating on live systems or the user's environment: `13-safe-live-operations.md`
  - Communication: `14-communication-and-reporting.md`
- **OpenChamber memory** (`memory_note` with `openchamber: true`): rules that reference OpenChamber-specific tools (sessions, schedules, knowledge panel) and should not leak into plain OpenCode, Cursor, or Copilot.

Write each memory entry with `memory_note`: one tight bullet, at most 500 characters, imperative, naming the ticket or PR as evidence. Call it once per entry, and never write to the same file in parallel calls.

If `_staging.md` had pending candidates that were all processed (saved or rejected), clear it with `memory_search` (`clearStaging: true`, scoped to the matching store).

Never store secrets, tokens, personal data, or unverified claims stated as fact.

### 5. Report

Reply in a few sentences, not a table: how many entries were saved and to which store/files, any skill/rule edits proposed instead of memory, one clause per rejected candidate with the reason (duplicate, too specific, unverified), and anything contradicting existing memory. Lead with gaps, such as causes that could not be confirmed.

---

## Compaction Mode ("compact memory", "prune memory", "audit memory")

Run this periodically or when `memory_search` flags a file as `large` or `unindexed`:

1. Call `memory_search` with no arguments to inventory all stores, bullet counts, unindexed files, and pending `_staging.md` items.
2. Read the flagged or largest topic files (and `MEMORY.md`) via `memory_search` (`file`) or `read`.
3. Identify:
   - Duplicate or near-duplicate bullets within or across files that can be merged into one sharper rule.
   - Stale or superseded facts (e.g. resolved workarounds, deleted branches/tools, old dates).
   - Bullets that belong in a skill, linter, or project config instead of memory.
   - Orphan topic files missing from `MEMORY.md`, or broken links in `MEMORY.md`.
4. Present a concise summary of proposed merges, deletions, and index fixes, and **wait for the user's approval** before editing or deleting any existing entries.

---

## Guardrails

- Do not rewrite or delete existing memory entries without asking.
- Do not invent a root cause to make a lesson tidy. "Cause not established" is a valid finding.
- Do not save the same lesson in two files.
- Mid-session, if you spot a likely learning before the session ends and don't want to interrupt the task, park it with `memory_note(..., stage: true)` so the next review curates it.
