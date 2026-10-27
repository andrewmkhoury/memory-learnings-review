#!/usr/bin/env node
// memory-mcp: stdio MCP server exposing the memory-inject system to any
// MCP-capable agent (Copilot, Claude Code, ...). Zero dependencies.
//
//   - tool `memory_note` — same write path as the OpenCode plugin
//   - resources           — the memory indexes, for recall at session start
//
// Framing: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, matchDir, readIndex, writeNote } from "./memory-core.mjs"

const DEFAULT_CONFIG = path.join(
  os.homedir(),
  ".config/opencode/plugins/memory-inject/config.json",
)
const configPath = () => process.env.MEMORY_INJECT_CONFIG ?? DEFAULT_CONFIG

const memoryNoteTool = {
  name: "memory_note",
  description:
    "Record a durable memory (lesson, preference, pitfall, decision) in the project's memory files. " +
    "Appends one tight bullet (max 500 chars) to the topic file — and to other configured project " +
    "dirs when the same file exists there — and adds a MEMORY.md index line for new files. Set " +
    "global: true to write to the cross-project global store. At the start of a session, read the " +
    "memory:// resources for your working directory to recall prior learnings.",
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description:
          "Absolute path of the project/repo you are working in. Required so the note lands in the right project's memory store.",
      },
      file: {
        type: "string",
        description: "Topic file basename, e.g. '30-project-context.md', or a new 'NN-<name>.md'",
      },
      note: { type: "string", description: "One tight bullet, max 500 chars" },
      title: { type: "string", description: "New files only: label for the MEMORY.md index line" },
      global: {
        type: "boolean",
        description: "Write to the global (cross-project) store instead of this project's store",
      },
    },
    required: ["directory", "file", "note"],
    additionalProperties: false,
  },
}

function listResources(cfg) {
  const out = []
  if (cfg.globalDir && existsSync(path.join(cfg.globalDir, "MEMORY.md"))) {
    out.push({
      uri: "memory://global",
      name: "Global memory index (all projects)",
      description: "Cross-project general rules — read at session start.",
    })
  }
  for (const m of cfg.memoryDirs) {
    const file = path.join(m.dir, "MEMORY.md")
    if (existsSync(file)) {
      out.push({
        uri: `memory://project/${encodeURIComponent(m.prefix)}`,
        name: `Memory index — ${m.prefix}`,
        description: `Project memory index for ${m.prefix}.`,
      })
    }
  }
  return out
}

function readResource(uri, cfg) {
  if (uri === "memory://global") {
    const file = path.join(cfg.globalDir ?? "", "MEMORY.md")
    if (!existsSync(file)) throw new Error("global store not configured")
    return { uri, text: readFileSync(file, "utf8") }
  }
  if (uri.startsWith("memory://project/")) {
    const prefix = decodeURIComponent(uri.slice("memory://project/".length))
    const match = cfg.memoryDirs.find(
      (m) => m.prefix === prefix || m.dir === matchDir(prefix, cfg)?.dir,
    )
    const file = match && path.join(match.dir, "MEMORY.md")
    if (!file || !existsSync(file)) throw new Error(`no memory index for ${prefix}`)
    return { uri, text: readFileSync(file, "utf8") }
  }
  throw new Error(`unknown resource uri: ${uri}`)
}

function handle(msg) {
  if (msg.id === undefined) return // notification (e.g. initialized) — nothing to answer
  const id = msg.id
  try {
    switch (msg.method) {
      case "initialize":
        return respond(id, {
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "memory-inject", version: "1.0.0" },
        })
      case "tools/list":
        return respond(id, { tools: [memoryNoteTool] })
      case "tools/call": {
        if (msg.params?.name !== "memory_note")
          throw new Error(`unknown tool: ${msg.params?.name}`)
        const p = msg.params.arguments ?? {}
        const result = writeNote({
          cfg: loadConfig(configPath()),
          directory: String(p.directory ?? "").trim(),
          file: String(p.file ?? "").trim(),
          note: String(p.note ?? "").replace(/\s*\n\s*/g, " ").trim(),
          title: p.title,
          isGlobal: p.global === true,
        })
        const isError = result.content.startsWith("error:")
        return respond(id, {
          content: [{ type: "text", text: result.content }],
          ...(isError ? { isError: true } : {}),
        })
      }
      case "resources/list":
        return respond(id, { resources: listResources(loadConfig(configPath())) })
      case "resources/read": {
        const r = readResource(String(msg.params?.uri ?? ""), loadConfig(configPath()))
        return respond(id, { contents: [{ uri: r.uri, text: r.text }] })
      }
      default:
        return respondError(id, -32601, `method not found: ${msg.method}`)
    }
  } catch (error) {
    return respondError(id, -32603, error instanceof Error ? error.message : String(error))
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
}

let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (error) {
      console.error("[memory-mcp] bad message:", error.message)
    }
  }
})
process.stdin.on("close", () => process.exit(0))
