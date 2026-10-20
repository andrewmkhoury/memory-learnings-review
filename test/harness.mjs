// Test harness for the memory-inject plugin. Runs the real plugin module
// against a mock OpenCode host in a sandboxed $HOME.
//
//   node --experimental-strip-types test/harness.mjs
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Sandboxed HOME so CLAUDE_HOME and the default config path never touch the
// real one. Must be set before the plugin module is imported.
const HOME = mkdtempSync(path.join(tmpdir(), "memory-inject-test-"))
process.env.HOME = HOME
process.env.MEMORY_INJECT_CONFIG = path.join(HOME, "config.json")

// --- sandbox layout ---------------------------------------------------------
const projA = path.join(HOME, "code", "alpha")
const projB = path.join(HOME, "code", "beta")
const memA = path.join(HOME, ".claude", "projects", "-sandbox-code-alpha", "memory")
const memB = path.join(HOME, ".claude", "projects", "-sandbox-code-beta", "memory")
mkdirSync(projA, { recursive: true })
mkdirSync(projB, { recursive: true })
mkdirSync(memA, { recursive: true })
mkdirSync(memB, { recursive: true })
writeFileSync(path.join(memA, "MEMORY.md"), "# Memory index\n\n## Environment-Specific Context\n")
writeFileSync(path.join(memB, "MEMORY.md"), "# Memory index\n\n## Environment-Specific Context\n")
writeFileSync(path.join(memB, "30-shared.md"), "- older entry\n")
const baseDir = path.join(HOME, "memory-store")
const globalDir = path.join(HOME, "global-memory")
mkdirSync(globalDir, { recursive: true })
writeFileSync(path.join(globalDir, "MEMORY.md"), "# Global memory\n\n## General rules\n")
writeFileSync(path.join(globalDir, "10-general-execution-rules.md"), "- existing global rule\n")
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify({
  memoryDirs: [
    { prefix: projA, dir: "~/.claude/projects/-sandbox-code-alpha/memory" },
    { prefix: projB, dir: "~/.claude/projects/-sandbox-code-beta/memory" },
    { prefix: "not-a-string-dir" }, // invalid entry: must be filtered
  ],
  baseDir, // unmapped directories fall back to <baseDir>/<slug> (fork-store mode)
  globalDir, // cross-project store, injected into every session
}))

// --- mock OpenCode host ------------------------------------------------------
const sessions = new Map()
const storage = new Map()
const promptHandlers = []
const addedTools = []
const ctx = {
  session: {
    hook: async (name, fn) => { if (name === "prompt") promptHandlers.push(fn) },
    get: async ({ sessionID }) => sessions.get(sessionID),
  },
  storage: { get: (k) => storage.get(k), set: (k, v) => storage.set(k, v) },
  tool: { transform: async (fn) => fn({ add: (t) => addedTools.push(t) }) },
}

const plugin = (await import(new URL("../plugins/memory-inject/index.ts", import.meta.url).href)).default
await plugin.setup(ctx)

const note = addedTools.find((t) => t.name === "memory_note")
assert.ok(note, "memory_note tool registered")
assert.equal(promptHandlers.length, 1, "one prompt handler registered")

// 1. new topic file: creates file, bootstraps nothing (index exists), indexes it
let out = await note.execute({ file: "40-notes.md", note: "first note on a new topic" }, { cwd: projA })
assert.match(out.content, /recorded in 40-notes.md/)
assert.match(out.content, /indexed in MEMORY.md/)
assert.equal(readFileSync(path.join(memA, "40-notes.md"), "utf8"), "- first note on a new topic\n")
assert.match(readFileSync(path.join(memA, "MEMORY.md"), "utf8"), /\[notes\]\(40-notes\.md\)/)
assert.equal(existsSync(path.join(memB, "40-notes.md")), false, "new topic file must not appear in siblings")
console.log("PASS 1: new topic file created, indexed, not leaked to siblings")

// 2. shared topic file: written to session's dir AND synced to sibling that has it
out = await note.execute({ file: "30-shared.md", note: "synced across projects" }, { cwd: projA })
assert.match(out.content, /all configured projects/)
assert.match(readFileSync(path.join(memA, "30-shared.md"), "utf8"), /synced across projects/)
assert.match(readFileSync(path.join(memB, "30-shared.md"), "utf8"), /^- older entry\n- synced across projects\n$/s)
console.log("PASS 2: shared topic file synced to sibling project")

// 3. idempotency: same note again is a no-op
out = await note.execute({ file: "30-shared.md", note: "synced across projects" }, { cwd: projA })
assert.equal(out.content, "already recorded — no change")
console.log("PASS 3: duplicate note is a no-op")

// 4. validation: oversize note and hostile basename rejected
out = await note.execute({ file: "40-notes.md", note: "x".repeat(501) }, { cwd: projA })
assert.match(out.content, /too long/)
out = await note.execute({ file: "../evil.md", note: "escape attempt" }, { cwd: projA })
assert.match(out.content, /plain basename/)
assert.equal(existsSync(path.join(memA, "..", "evil.md")), false)
console.log("PASS 4: oversize note and path-escape basename rejected")

// 5. recall: project + global index attached once per session for mapped projects
sessions.set("s1", { location: { directory: projA } })
const event1 = { sessionID: "s1", prompt: {} }
await promptHandlers[0](event1)
assert.deepEqual(
  event1.prompt.files.map((f) => f.uri),
  [`file://${path.join(memA, "MEMORY.md")}`, `file://${path.join(globalDir, "MEMORY.md")}`],
)
const event1b = { sessionID: "s1", prompt: {} }
await promptHandlers[0](event1b)
assert.equal(event1b.prompt.files, undefined, "index attached only once per session")
console.log("PASS 5: recall attaches project + global index once per session")

// 6. recall: unmapped directory falls back to <baseDir>/<slug> (fork-store mode)
const stray = path.join(HOME, "scratch", "gamma")
const expectedStrayMem = path.join(baseDir, stray.replace(/\//g, "-"))
mkdirSync(expectedStrayMem, { recursive: true })
writeFileSync(path.join(expectedStrayMem, "MEMORY.md"), "# Memory index\n")
sessions.set("s2", { location: { directory: stray } })
const event2 = { sessionID: "s2", prompt: {} }
await promptHandlers[0](event2)
assert.deepEqual(
  event2.prompt.files.map((f) => f.uri),
  [`file://${path.join(expectedStrayMem, "MEMORY.md")}`, `file://${path.join(globalDir, "MEMORY.md")}`],
)
console.log("PASS 6: unmapped directory resolves to <baseDir>/<slug>, global still attached")

// 7. write path: unmapped directory also works (per-project memory anywhere)
out = await note.execute({ file: "10-rules.md", note: "stray dir note" }, { cwd: stray })
assert.match(out.content, /recorded in 10-rules.md/)
assert.match(readFileSync(path.join(expectedStrayMem, "10-rules.md"), "utf8"), /stray dir note/)
console.log("PASS 7: memory_note works for unmapped directories")

// 8. global write: new topic file lands in globalDir, indexed, not in the project store
out = await note.execute({ file: "90-global-topic.md", note: "a cross-project rule", global: true }, { cwd: projA })
assert.match(out.content, /recorded in 90-global-topic.md/)
assert.match(out.content, /indexed in MEMORY.md/)
assert.equal(readFileSync(path.join(globalDir, "90-global-topic.md"), "utf8"), "- a cross-project rule\n")
assert.match(readFileSync(path.join(globalDir, "MEMORY.md"), "utf8"), /\[global topic\]\(90-global-topic\.md\)/)
assert.equal(existsSync(path.join(memA, "90-global-topic.md")), false, "global note must not leak into the project store")
console.log("PASS 8: global note written to globalDir only, indexed there")

// 9. global write: appends to an existing global topic file; duplicate is a no-op
out = await note.execute({ file: "10-general-execution-rules.md", note: "global append", global: true }, { cwd: projA })
assert.match(out.content, /recorded in 10-general-execution-rules.md/)
assert.match(readFileSync(path.join(globalDir, "10-general-execution-rules.md"), "utf8"), /global append/)
out = await note.execute({ file: "90-global-topic.md", note: "a cross-project rule", global: true }, { cwd: projB })
assert.equal(out.content, "already recorded — no change")
console.log("PASS 9: global note appends to existing file; duplicate is a no-op")

// 10. global write without globalDir configured is a clean error, not a crash
process.env.MEMORY_INJECT_CONFIG = path.join(HOME, "no-such-config.json")
out = await note.execute({ file: "90-x.md", note: "needs global", global: true }, { cwd: projA })
assert.match(out.content, /global store not configured/)
process.env.MEMORY_INJECT_CONFIG = path.join(HOME, "config.json")
console.log("PASS 10: global note without globalDir is a clean error")

console.log(`\nall 10 tests passed (sandbox: ${HOME})`)
