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
// Isolate from OpenChamber: this env var is set when the test host itself is
// an OpenChamber session, and would otherwise activate the OC store below.
delete process.env.OPENCHAMBER_HOST

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
const ocDir = path.join(HOME, "openchamber-memory")
mkdirSync(globalDir, { recursive: true })
mkdirSync(ocDir, { recursive: true })
writeFileSync(path.join(globalDir, "MEMORY.md"), "# Global memory\n\n## General rules\n")
writeFileSync(path.join(globalDir, "10-general-execution-rules.md"), "- existing global rule\n")
writeFileSync(path.join(ocDir, "MEMORY.md"), "# OpenChamber memory\n\n## OpenChamber rules\n")
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify({
  memoryDirs: [
    { prefix: projA, dir: "~/.claude/projects/-sandbox-code-alpha/memory" },
    { prefix: projB, dir: "~/.claude/projects/-sandbox-code-beta/memory" },
    { prefix: "not-a-string-dir" }, // invalid entry: must be filtered
  ],
  baseDir, // unmapped directories fall back to <baseDir>/<slug> (fork-store mode)
  globalDir, // cross-project store, injected into every session
  openchamberDir: ocDir, // injected into OpenChamber sessions only
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

// 11. OpenChamber scope: with OPENCHAMBER_HOST set, the OC index is attached
//     (third file) and only in OpenChamber-looking sessions
process.env.OPENCHAMBER_HOST = "127.0.0.1"
sessions.set("s3", { location: { directory: projA } })
const event3 = { sessionID: "s3", prompt: {} }
await promptHandlers[0](event3)
assert.deepEqual(
  event3.prompt.files.map((f) => f.uri),
  [
    `file://${path.join(memA, "MEMORY.md")}`,
    `file://${path.join(globalDir, "MEMORY.md")}`,
    `file://${path.join(ocDir, "MEMORY.md")}`,
  ],
)
delete process.env.OPENCHAMBER_HOST
sessions.set("s4", { location: { directory: projA } })
const event4 = { sessionID: "s4", prompt: {} }
await promptHandlers[0](event4)
assert.deepEqual(
  event4.prompt.files.map((f) => f.uri),
  [`file://${path.join(memA, "MEMORY.md")}`, `file://${path.join(globalDir, "MEMORY.md")}`],
  "OC index must not be attached outside OpenChamber sessions",
)
console.log("PASS 11: OC index attached only when OPENCHAMBER_HOST is set")

// 12. openchamber: true writes to the OC store only, indexed, no sibling sync
out = await note.execute({ file: "50-oc-rules.md", note: "an openchamber-only rule", openchamber: true }, { cwd: projA })
assert.match(out.content, /recorded in 50-oc-rules.md/)
assert.match(out.content, /indexed in MEMORY.md/)
assert.equal(readFileSync(path.join(ocDir, "50-oc-rules.md"), "utf8"), "- an openchamber-only rule\n")
assert.match(readFileSync(path.join(ocDir, "MEMORY.md"), "utf8"), /\[oc rules\]\(50-oc-rules\.md\)/)
assert.equal(existsSync(path.join(memA, "50-oc-rules.md")), false, "OC note must not leak into the project store")
console.log("PASS 12: openchamber note written to the OC store only, indexed there")

// 13. openchamber: true without openchamberDir configured is a clean error
const cfgRaw = JSON.parse(readFileSync(process.env.MEMORY_INJECT_CONFIG, "utf8"))
delete cfgRaw.openchamberDir
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify(cfgRaw))
out = await note.execute({ file: "50-oc-rules.md", note: "needs oc store", openchamber: true }, { cwd: projA })
assert.match(out.content, /OpenChamber store not configured/)
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify({ ...cfgRaw, openchamberDir: ocDir }))
console.log("PASS 13: openchamber note without openchamberDir is a clean error")

// 14. longest-prefix-first: nested project mapping beats parent even when listed second
const nestedProj = path.join(projA, "nested-app")
const memNested = path.join(HOME, "mem-nested")
mkdirSync(nestedProj, { recursive: true })
mkdirSync(memNested, { recursive: true })
const cfgWithNested = JSON.parse(readFileSync(process.env.MEMORY_INJECT_CONFIG, "utf8"))
cfgWithNested.memoryDirs.push({ prefix: nestedProj, dir: memNested })
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify(cfgWithNested))
out = await note.execute({ file: "30-nested.md", note: "nested project note" }, { cwd: nestedProj })
assert.match(out.content, /recorded in 30-nested.md/)
assert.equal(existsSync(path.join(memNested, "30-nested.md")), true, "nested dir must win over parent prefix")
assert.equal(existsSync(path.join(memA, "30-nested.md")), false, "parent dir must not receive nested note")
console.log("PASS 14: longest-prefix-first memoryDirs matching")

// 15. MEMORY.md cannot be written to directly via memory_note
out = await note.execute({ file: "MEMORY.md", note: "should not overwrite index" }, { cwd: projA })
assert.match(out.content, /managed automatically/)
console.log("PASS 15: MEMORY.md direct write rejected")

// 16. mid-session staging: stage: true writes to _staging.md (not indexed), clearStaging removes it
const search = addedTools.find((t) => t.name === "memory_search")
assert.ok(search, "memory_search tool registered")
out = await note.execute({ file: "40-notes.md", note: "candidate to review later", stage: true }, { cwd: projA })
assert.match(out.content, /staged in _staging\.md/)
assert.equal(readFileSync(path.join(memA, "_staging.md"), "utf8"), "- candidate to review later [target: 40-notes.md]\n")
assert.equal(readFileSync(path.join(memA, "MEMORY.md"), "utf8").includes("_staging.md"), false)
out = await note.execute({ file: "40-notes.md", note: "candidate to review later", stage: true }, { cwd: projA })
assert.equal(out.content, "already staged — no change")
let inv = await search.execute({}, { cwd: projA })
assert.match(inv.content, /_staging\.md: 1 pending candidate/)
assert.match(inv.content, /candidate to review later/)
out = await search.execute({ clearStaging: true }, { cwd: projA })
assert.match(out.content, /cleared _staging\.md/)
assert.equal(existsSync(path.join(memA, "_staging.md")), false)
console.log("PASS 16: staging parks candidates in _staging.md and clearStaging removes it")

// 17. memory_search: inventory flags orphans & bloat, query searches across stores, file reads topic safely
writeFileSync(path.join(memA, "99-orphan.md"), Array.from({ length: 26 }, (_, i) => `- bullet ${i}`).join("\n") + "\n")
inv = await search.execute({}, { cwd: projA })
assert.match(inv.content, /99-orphan\.md: 26 bullets \(unindexed, large — consider compacting\)/)
let qOut = await search.execute({ query: "cross-project" }, { cwd: projA })
assert.match(qOut.content, /\[global\] 90-global-topic\.md:1: - a cross-project rule/)
let fOut = await search.execute({ file: "40-notes.md" }, { cwd: projA })
assert.equal(fOut.content, "- first note on a new topic\n")
let badFile = await search.execute({ file: "../evil.md" }, { cwd: projA })
assert.match(badFile.content, /file not found/)
console.log("PASS 17: memory_search inventory (orphan/bloat flags), keyword query, and safe file read")

// 18. snippet truncation + cross-store duplicate flagging in memory_search
writeFileSync(
  path.join(memA, "10-general-execution-rules.md"),
  `- ${"a".repeat(300)} NEEDLE_TOKEN ${"b".repeat(300)}\n`,
)
inv = await search.execute({}, { cwd: projA })
assert.match(inv.content, /10-general-execution-rules\.md:.*also in global/)
let snip = await search.execute({ query: "NEEDLE_TOKEN" }, { cwd: projA })
assert.match(snip.content, /NEEDLE_TOKEN/)
assert.ok(snip.content.length < 340, `expected truncated snippet, got ${snip.content.length} chars`)
console.log("PASS 18: memory_search truncates long bullets and flags cross-store duplicate filenames")

// 19. turn-1 context guard: maxIndexBytes compacts oversized MEMORY.md; injectIndex: false skips attach
const bigLines = Array.from({ length: 60 }, (_, i) => `- [topic ${i}](${i}-topic.md) — ${"verbose summary ".repeat(5)}`)
writeFileSync(path.join(memA, "MEMORY.md"), "# Memory index\n\n" + bigLines.join("\n") + "\n")
const cfgGuard = JSON.parse(readFileSync(process.env.MEMORY_INJECT_CONFIG, "utf8"))
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify({ ...cfgGuard, maxIndexBytes: 600 }))
sessions.set("s5", { location: { directory: projA } })
const event5 = { sessionID: "s5", prompt: {} }
await promptHandlers[0](event5)
const attachedA = event5.prompt.files[0].uri.replace("file://", "")
assert.notEqual(attachedA, path.join(memA, "MEMORY.md"), "oversized index should attach compacted copy")
const compactBody = readFileSync(attachedA, "utf8")
assert.ok(Buffer.byteLength(compactBody, "utf8") <= 600, `compacted index exceeded 600 bytes: ${Buffer.byteLength(compactBody, "utf8")}`)
assert.match(compactBody, /compacted for turn-1 budget/)
assert.equal(compactBody.includes("verbose summary"), false, "descriptions should be stripped")

writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify({ ...cfgGuard, injectIndex: false }))
sessions.set("s6", { location: { directory: projA } })
const event6 = { sessionID: "s6", prompt: {} }
await promptHandlers[0](event6)
assert.equal(event6.prompt.files, undefined, "injectIndex: false must attach nothing on turn 1")
writeFileSync(process.env.MEMORY_INJECT_CONFIG, JSON.stringify(cfgGuard))
console.log("PASS 19: maxIndexBytes compacts oversized MEMORY.md; injectIndex: false skips turn-1 attach")

console.log(`\nall 19 tests passed (sandbox: ${HOME})`)
