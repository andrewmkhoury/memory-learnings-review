// Test harness for the memory-mcp server. Spawns the real server process and
// drives it over the MCP stdio protocol (newline-delimited JSON-RPC 2.0) in a
// sandboxed $HOME, so the on-disk effects are verified, not mocked.
//
//   node test/mcp-harness.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// --- sandbox layout ----------------------------------------------------------
const HOME = mkdtempSync(path.join(tmpdir(), "memory-mcp-test-"))
const projA = path.join(HOME, "code", "alpha")
const projB = path.join(HOME, "code", "beta")
const memA = path.join(HOME, "mem-alpha")
const memB = path.join(HOME, "mem-beta")
const baseDir = path.join(HOME, "store")
const globalDir = path.join(HOME, "global-memory")
const stray = path.join(HOME, "scratch", "gamma")
const memStray = path.join(baseDir, stray.replace(/\//g, "-"))

for (const d of [projA, projB, memA, memB, globalDir]) mkdirSync(d, { recursive: true })
writeFileSync(path.join(memA, "MEMORY.md"), "# Memory index\n\n## Environment-Specific Context\n")
writeFileSync(path.join(memB, "MEMORY.md"), "# Memory index\n\n## Environment-Specific Context\n")
writeFileSync(path.join(memB, "30-shared.md"), "- older entry\n")
writeFileSync(path.join(globalDir, "MEMORY.md"), "# Global memory\n\n## General rules\n")
const cfgPath = path.join(HOME, "config.json")
writeFileSync(cfgPath, JSON.stringify({
  memoryDirs: [
    { prefix: projA, dir: memA },
    { prefix: projB, dir: memB },
  ],
  baseDir,
  globalDir,
}))

// --- MCP stdio client --------------------------------------------------------
const mcpPath = new URL("../plugins/memory-inject/memory-mcp.mjs", import.meta.url).pathname
const child = spawn("node", [mcpPath], {
  env: { ...process.env, HOME, MEMORY_INJECT_CONFIG: cfgPath },
  stdio: ["pipe", "pipe", "pipe"],
})
let stderr = ""
child.stderr.on("data", (d) => (stderr += d))

let nextId = 1
const pending = new Map()
let buf = ""
child.stdout.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 5000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")

const callNote = (args) =>
  rpc("tools/call", { name: "memory_note", arguments: args }).then((msg) => {
    assert.ok(msg.result, `tools/call returned an error: ${JSON.stringify(msg.error)}`)
    return { text: msg.result.content[0].text, isError: msg.result.isError === true }
  })

try {
  // 1. initialize handshake
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness", version: "0.0.1" },
  })
  assert.equal(init.result.serverInfo.name, "memory-inject")
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} })
  notify("notifications/initialized")
  console.log("PASS 1: initialize handshake")

  // 2. tools/list exposes memory_note with directory required
  const tools = (await rpc("tools/list")).result.tools
  const note = tools.find((t) => t.name === "memory_note")
  assert.ok(note, "memory_note tool listed")
  assert.ok(note.inputSchema.required.includes("directory"))
  assert.ok(note.inputSchema.required.includes("file"))
  assert.ok(note.inputSchema.required.includes("note"))
  console.log("PASS 2: tools/list exposes memory_note (directory/file/note required)")

  // 3. write a new topic file into project A: file created, indexed
  let out = await callNote({ directory: projA, file: "40-notes.md", note: "first note on a new topic" })
  assert.equal(out.isError, false)
  assert.match(out.text, /recorded in 40-notes.md/)
  assert.match(out.text, /indexed in MEMORY.md/)
  assert.equal(readFileSync(path.join(memA, "40-notes.md"), "utf8"), "- first note on a new topic\n")
  assert.match(readFileSync(path.join(memA, "MEMORY.md"), "utf8"), /\[notes\]\(40-notes\.md\)/)
  assert.equal(existsSync(path.join(memB, "40-notes.md")), false, "new topic must not leak to siblings")
  console.log("PASS 3: tools/call writes a new topic file, indexed")

  // 4. duplicate note is a no-op
  out = await callNote({ directory: projA, file: "40-notes.md", note: "first note on a new topic" })
  assert.equal(out.text, "already recorded — no change")
  console.log("PASS 4: duplicate note is a no-op")

  // 5. shared topic file syncs to the sibling project
  out = await callNote({ directory: projA, file: "30-shared.md", note: "synced across projects" })
  assert.match(out.text, /all configured projects/)
  assert.match(readFileSync(path.join(memB, "30-shared.md"), "utf8"), /^- older entry\n- synced across projects\n$/s)
  console.log("PASS 5: shared topic file synced to sibling project")

  // 6. unmapped directory falls back to <baseDir>/<slug> (fork-store mode)
  out = await callNote({ directory: stray, file: "10-rules.md", note: "stray dir note" })
  assert.match(out.text, /recorded in 10-rules.md/)
  assert.equal(readFileSync(path.join(memStray, "10-rules.md"), "utf8"), "- stray dir note\n")
  console.log("PASS 6: unmapped directory resolves to <baseDir>/<slug>")

  // 7. missing directory is a clean tool error, not a crash or a misroute
  out = await callNote({ file: "40-notes.md", note: "where did this go" })
  assert.equal(out.isError, true)
  assert.match(out.text, /no memory directory mapped/)
  assert.equal(
    readFileSync(path.join(memA, "40-notes.md"), "utf8"),
    "- first note on a new topic\n",
    "misrouted write must not touch any store",
  )
  console.log("PASS 7: missing directory is a clean isError, nothing written")

  // 8. validation: oversize note and hostile basename rejected as tool errors
  out = await callNote({ directory: projA, file: "40-notes.md", note: "x".repeat(501) })
  assert.equal(out.isError, true)
  assert.match(out.text, /too long/)
  out = await callNote({ directory: projA, file: "../evil.md", note: "escape attempt" })
  assert.equal(out.isError, true)
  assert.match(out.text, /plain basename/)
  assert.equal(existsSync(path.join(memA, "..", "evil.md")), false)
  console.log("PASS 8: oversize note and path-escape basename rejected")

  // 9. global write lands in globalDir only
  out = await callNote({ directory: projA, file: "90-global-topic.md", note: "a cross-project rule", global: true })
  assert.equal(out.isError, false)
  assert.match(out.text, /recorded in 90-global-topic.md/)
  assert.equal(readFileSync(path.join(globalDir, "90-global-topic.md"), "utf8"), "- a cross-project rule\n")
  assert.match(readFileSync(path.join(globalDir, "MEMORY.md"), "utf8"), /\[global topic\]\(90-global-topic\.md\)/)
  assert.equal(existsSync(path.join(memA, "90-global-topic.md")), false, "global note must not leak into the project store")
  console.log("PASS 9: global note written to globalDir only, indexed there")

  // 10. resources/list exposes the global index and both project indexes
  const resources = (await rpc("resources/list")).result.resources
  const uris = resources.map((r) => r.uri)
  assert.ok(uris.includes("memory://global"), "global resource listed")
  assert.ok(uris.includes(`memory://project/${encodeURIComponent(projA)}`), "project A resource listed")
  assert.ok(uris.includes(`memory://project/${encodeURIComponent(projB)}`), "project B resource listed")
  assert.ok(!uris.includes(`memory://project/${encodeURIComponent(stray)}`), "store-only dirs are not resources")
  console.log("PASS 10: resources/list exposes global + configured project indexes")

  // 11. resources/read returns the index text
  const readA = (await rpc("resources/read", { uri: `memory://project/${encodeURIComponent(projA)}` }))
  assert.match(readA.result.contents[0].text, /\[notes\]\(40-notes\.md\)/)
  const readG = (await rpc("resources/read", { uri: "memory://global" }))
  assert.match(readG.result.contents[0].text, /Global memory/)
  const readMissing = await rpc("resources/read", { uri: `memory://project/${encodeURIComponent(stray)}` })
  assert.ok(readMissing.error, "unknown project index is a JSON-RPC error")
  console.log("PASS 11: resources/read returns index text; unknown uri is an error")

  // 12. server survived the whole session; clean shutdown on stdin close
  child.stdin.end()
  const code = await new Promise((resolve) => child.on("close", resolve))
  assert.equal(code, 0)
  assert.equal(stderr, "", `unexpected stderr: ${stderr}`)
  console.log("PASS 12: clean shutdown, no stderr noise")
} finally {
  child.kill()
}

console.log(`\nall 12 MCP tests passed (sandbox: ${HOME})`)
