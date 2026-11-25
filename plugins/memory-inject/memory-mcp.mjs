#!/usr/bin/env node
// memory-mcp: stdio MCP server exposing the memory-inject system to any
// MCP-capable agent (Cursor, Copilot, Claude Code, ...). Zero dependencies.
//
//   - tools     — `memory_note` (write/stage) and `memory_search` (inventory/search/read/clearStaging)
//   - resources — memory indexes and topic files for recall at session start
//
// Framing: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  clearStaging,
  loadConfig,
  matchDir,
  readStoreFile,
  resolveScopeDir,
  searchMemory,
  writeNote,
} from "./memory-core.mjs"

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
    "global: true for the cross-project global store, openchamber: true for the OpenChamber store, " +
    "or stage: true to park a candidate in _staging.md for later curation. At session start, read the " +
    "memory:// resources for your working directory (or call memory_search) to recall prior learnings.",
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
      openchamber: {
        type: "boolean",
        description: "Write to the OpenChamber-only store instead of this project's store",
      },
      stage: {
        type: "boolean",
        description: "Park as a pending candidate in _staging.md instead of committing to permanent memory",
      },
    },
    required: ["directory", "file", "note"],
    additionalProperties: false,
  },
}

const memorySearchTool = {
  name: "memory_search",
  description:
    "Inspect or search memory across project and global stores. Omit query and file to list all " +
    "topic files with bullet counts, orphan/bloat flags, and pending _staging.md candidates. Pass " +
    "query to search lines, file to read one topic file, or clearStaging: true to clear _staging.md.",
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Absolute path of the project/repo you are working in.",
      },
      query: { type: "string", description: "Case-insensitive keyword to search across topic files" },
      file: {
        type: "string",
        description: "Read a specific topic file basename (e.g. '30-project-context.md' or '_staging.md')",
      },
      global: { type: "boolean", description: "Scope file/clearStaging to the global store" },
      openchamber: { type: "boolean", description: "Scope file/clearStaging to the OpenChamber store" },
      clearStaging: {
        type: "boolean",
        description: "Remove _staging.md for the selected scope after curating its candidates",
      },
    },
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
  if (uri === "memory://global" || uri.startsWith("memory://global/")) {
    const fileName = uri === "memory://global" ? "MEMORY.md" : uri.slice("memory://global/".length)
    const res = readStoreFile(cfg.globalDir, fileName)
    if (!res) throw new Error(`global resource not found: ${fileName}`)
    return { uri, text: res.text }
  }
  if (uri.startsWith("memory://project/")) {
    const rest = uri.slice("memory://project/".length)
    const slash = rest.indexOf("/")
    const prefix = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
    const fileName = slash === -1 ? "MEMORY.md" : rest.slice(slash + 1)
    const match = matchDir(prefix, cfg)
    const res = match && readStoreFile(match.dir, fileName)
    if (!res) throw new Error(`no memory resource for ${prefix} (${fileName})`)
    return { uri, text: res.text }
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
          serverInfo: { name: "memory-inject", version: "1.1.0" },
        })
      case "tools/list":
        return respond(id, { tools: [memoryNoteTool, memorySearchTool] })
      case "tools/call": {
        const name = msg.params?.name
        const p = msg.params?.arguments ?? {}
        const cfg = loadConfig(configPath())
        let result
        if (name === "memory_note") {
          result = writeNote({
            cfg,
            directory: String(p.directory ?? "").trim(),
            file: String(p.file ?? "").trim(),
            note: String(p.note ?? "").replace(/\s*\n\s*/g, " ").trim(),
            title: p.title,
            isGlobal: p.global === true,
            isOpenChamber: p.openchamber === true,
            stage: p.stage === true,
          })
        } else if (name === "memory_search") {
          const directory = String(p.directory ?? "").trim()
          const isGlobal = p.global === true
          const isOC = p.openchamber === true
          if (p.clearStaging === true) {
            result = clearStaging({ cfg, directory, isGlobal, isOpenChamber: isOC })
          } else if (p.file) {
            const { home, error } = resolveScopeDir({ cfg, directory, isGlobal, isOpenChamber: isOC })
            if (error) {
              result = { content: error }
            } else {
              const res = readStoreFile(home.dir, String(p.file).trim())
              result = res ? { content: res.text } : { content: `error: file not found (${p.file})` }
            }
          } else {
            result = searchMemory({
              cfg,
              directory,
              query: p.query,
              includeOpenChamber: isOC,
            })
          }
        } else {
          throw new Error(`unknown tool: ${name}`)
        }
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
