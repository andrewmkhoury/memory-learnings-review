# memory-learnings-review

A skill that teaches a coding agent to curate its own long-term memory: turn a
session's findings into a small number of high-value, deduplicated memory
entries — and prefer saving *nothing* over saving noise.

## What it is

Agents like Claude Code and OpenCode can keep durable memory across sessions,
but left alone they fill it with junk: speculation, duplicates, ticket trivia.
This skill is the curation gate. When you say "save what we learned", "update
memory", or "what should we remember", the agent runs a fixed five-step review
and writes back only entries that survive a value test.

## How the memory system works

The skill is the curation layer on top of a simple file-based memory store:

1. **Memory store** — per-project markdown files. An index file (`MEMORY.md`)
   lists the topic files; each topic file is a bullet list of one-line entries.
   The convention is `~/.claude/projects/<project-slug>/memory/`, where
   `<project-slug>` is the absolute project path with `/` replaced by `-`.
2. **Recall** — the index is injected into the agent's context once per
   session (by the bundled `memory-inject` OpenCode plugin, or by Claude
   Code's auto-memory feature), so every session starts knowing what is
   stored. Topic files are read on demand.
3. **Write path** — the `memory_note` tool (registered by the same plugin; or
   plain file edits) appends one bullet per entry and adds an index line for
   new topic files. If you have several checkouts of the same project mapped
   in the plugin config, the same topic files stay in sync across them.
4. **Curation** — this skill. It decides *what* is worth writing and *where*.
   Global, cross-project rules can live in a global agent-instructions file
   (e.g. `~/.config/opencode/AGENTS.md`).

### The `memory-inject` plugin

An OpenCode plugin (`plugins/memory-inject/index.ts`, no runtime
dependencies) that provides recall and the write path:

- On the first prompt of each session it attaches the matching project's
  `MEMORY.md` to the prompt (once per session, keyed in plugin storage).
- It registers the `memory_note` tool: validates the note (one bullet,
  ≤500 chars), appends it idempotently to the topic file, syncs sibling
  configured projects, and indexes new topic files in `MEMORY.md`.
- Project → memory-dir resolution is automatic (slug convention above).
  Optional explicit mappings live in
  `~/.config/opencode/plugins/memory-inject/config.json` (see
  `config.example.json`); `~` is expanded.

## How the skill works

- **Collect candidates** — scan the session for verified mistakes and their
  causes, user corrections, time sinks, surprising verified facts, and fixes
  that passed for the wrong reason. Each candidate must carry evidence
  (ticket, PR, command output); no evidence, dropped.
- **Value test** — an entry is kept only if it is *generic* (useful beyond
  this ticket), *non-obvious*, *evidence-backed*, *actionable*, *not
  derivable from the code/git history/ticket*, and *not already stored*.
  Hard cap of 8 entries per run.
- **Deduplicate** — candidates are checked against the existing index and
  topic files; near-duplicates are skipped or refined, and contradictions are
  surfaced to the user rather than silently appended.
- **Route and write** — each entry goes to a topic file by type
  (execution rules, test rules, debugging, live operations, communication,
  project context). One tight bullet, ≤500 chars, naming its evidence.
  Secrets, tokens, and unverified claims never enter the store.
- **Report** — a few sentences: what was saved where, what was rejected and
  why, what contradicts existing memory, leading with gaps.

Guardrails: never rewrite or delete existing entries without asking, never
invent a root cause ("cause not established" is a valid finding), never store
the same lesson twice.

## Why it's worth having

- **Memory stays high-signal.** The value test plus the 8-entry cap means
  recall cost stays flat; the agent isn't reading a journal, it's reading
  rules.
- **Lessons survive handoffs.** Bugs fixed once, pitfalls hit once — future
  sessions (including on a fresh machine, since the files are plain markdown
  you can version) start knowing them.
- **No silent drift.** Deduplication and contradiction-checking keep the
  store consistent instead of accumulating conflicting advice.
- **Safe by construction.** Evidence required, secrets forbidden, no
  destructive writes.

## Porting to your setup

The skill's curation logic is tool-agnostic, with three spots to adapt:

- The memory paths in step 3 (`~/.claude/projects/<slug>/memory/`, and the
  global agent-instructions file if you use one).
- The topic-file names in step 4 — replace with your own categories.
- The `memory_note` tool reference in step 4 — substitute whatever write
  path you have (or plain file edits).

The plugin is generic out of the box; nothing to port unless your memory
store lives somewhere unusual.

## Install

- **Skill**: copy `skills/memory-learnings-review/` into your agent's skills
  directory (e.g. `~/.claude/skills/`).
- **Plugin** (OpenCode): copy `plugins/memory-inject/` into
  `~/.config/opencode/plugins/`, then register it by adding its directory
  to the `plugins` array in `~/.config/opencode/opencode.json`:

  ```json
  { "plugins": ["/Users/<you>/.config/opencode/plugins/memory-inject"] }
  ```

  Optionally add a `config.json` (see `config.example.json`) for explicit
  project → memory-dir mappings, especially for sibling checkouts of the
  same project.

No runtime, no API, no network — just markdown on disk.

## Repo layout

- `skills/memory-learnings-review/SKILL.md` — the curation skill.
- `plugins/memory-inject/` — the recall + `memory_note` OpenCode plugin and
  a `config.example.json`.
- `README.md` — this file.
