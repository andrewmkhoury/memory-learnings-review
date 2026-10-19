---
name: memory-learnings-review
description: Reviews what was found and learned in the current session (bugs, wrong assumptions, user corrections, wasted time, surprising facts) and decides which are valuable enough to save to the project memory store, rejecting the rest. Use when the user asks to save learnings, update memory, do a retrospective, "what should we remember", or after a long debugging or review session that surfaced non-obvious lessons.
---

# Memory Learnings Review

Turn a session's findings into a small number of high-value, deduplicated memory entries. Prefer saving nothing over saving noise.

## Process

### 1. Collect candidates

Scan the conversation for:
- Mistakes made by the agent or the code, and what actually caused them (only causes that were verified).
- User corrections or stated preferences.
- Time sinks: where effort was wasted and what would have avoided it.
- Facts about systems, tooling, or the environment that were surprising and verified.
- Fixes that passed review or tests for the wrong reason.

List each candidate as one sentence with its evidence (ticket, PR, command output). Drop any candidate without evidence from this session.

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

Read the memory index and the topic file each candidate would go in:
- Project memory lives under `~/.claude/projects/<project-slug>/memory/` (index `MEMORY.md`).
- Global rules live in `~/.config/opencode/AGENTS.md`.

If an existing entry already says it, skip. If an entry is close but missing the new nuance, write one new bullet that adds only the nuance and names what it refines. If an entry is contradicted by the new evidence, tell the user instead of silently adding a conflicting bullet.

### 4. Route and write

Choose the topic file by type:
- Execution and verification rules: `10-general-execution-rules.md`
- Test-writing rules: `11-tdd-default-workflow.md`
- Debugging method and gotchas: `12-debugging-and-validation-ladder.md`
- Operating on live systems or the user's environment: `13-safe-live-operations.md`
- Communication: `14-communication-and-reporting.md`
- Repo, service, or tooling facts: `30-<your-project>-context.md`

Write each entry with the `memory_note` tool: one tight bullet, at most 500 characters, imperative, naming the ticket or PR as evidence. Call it once per entry, and never write to the same file in parallel calls.

Never store secrets, tokens, personal data, or unverified claims stated as fact.

### 5. Report

Reply in a few sentences, not a table: how many entries were saved and to which files, one clause per rejected candidate with the reason (duplicate, too specific, unverified), and anything contradicting existing memory. Lead with gaps, such as causes that could not be confirmed.

## Guardrails

- Do not rewrite or delete existing memory entries without asking.
- Do not invent a root cause to make a lesson tidy. "Cause not established" is a valid finding.
- Do not save the same lesson in two files.
