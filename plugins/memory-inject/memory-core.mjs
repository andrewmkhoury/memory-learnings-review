// Shared memory-store logic for the memory-inject system. Pure Node, no
// dependencies, used by both the OpenCode plugin (index.ts) and the MCP
// server (memory-mcp.mjs). Sync I/O is fine: files are small and local.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

export function slugFor(directory) {
  return directory.replace(/\//g, "-")
}

/** @returns {{memoryDirs: Array<{prefix:string,dir:string}>, baseDir?: string, globalDir?: string}} */
export function loadConfig(cfgPath) {
  let raw
  try {
    raw = readFileSync(cfgPath, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error(`[memory-inject] ignoring unreadable config ${cfgPath}:`, error)
    return { memoryDirs: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(`[memory-inject] ignoring invalid config ${cfgPath}:`, error)
    return { memoryDirs: [] }
  }
  const memoryDirs = (parsed.memoryDirs ?? [])
    .filter((m) => typeof m.prefix === "string" && typeof m.dir === "string")
    .map((m) => ({ prefix: expand(m.prefix), dir: expand(m.dir) }))
  const baseDir = typeof parsed.baseDir === "string" ? expand(parsed.baseDir) : undefined
  const globalDir = typeof parsed.globalDir === "string" ? expand(parsed.globalDir) : undefined
  return { memoryDirs, baseDir, globalDir }
}

export function matchDir(directory, cfg) {
  if (!directory) return undefined
  const explicit = cfg.memoryDirs.find(
    (m) => directory === m.prefix || directory.startsWith(`${m.prefix}/`),
  )
  if (explicit) return explicit
  const slug = slugFor(directory)
  const dir = cfg.baseDir
    ? path.join(cfg.baseDir, slug)
    : path.join(os.homedir(), ".claude", "projects", slug, "memory")
  return { prefix: directory, dir }
}

export function validateNote(file, note) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(file))
    return "error: file must be a plain basename like 40-topic-name.md"
  if (!note) return "error: note is required"
  if (note.length > 500)
    return "error: note too long (max 500 chars) — keep it to one tight bullet"
  return undefined
}

/**
 * Append one bullet to a topic file (and to sibling configured projects that
 * already have it), indexing new files in MEMORY.md. Idempotent.
 * @returns {{content: string}}
 */
export function writeNote({ cfg, directory, file, note, title, isGlobal = false }) {
  const validation = validateNote(file, note)
  if (validation) return { content: validation }

  let home
  if (isGlobal) {
    if (!cfg.globalDir)
      return { content: "error: global store not configured (set globalDir in the plugin config)" }
    home = { prefix: "", dir: cfg.globalDir }
  } else {
    home = matchDir(directory, cfg)
    if (!home)
      return { content: "error: no memory directory mapped for this session's directory" }
  }

  mkdirSync(home.dir, { recursive: true })
  const idxPath = path.join(home.dir, "MEMORY.md")
  if (!existsSync(idxPath))
    writeFileSync(idxPath, "# Memory index\n\n## Environment-Specific Context\n")
  const primary = path.join(home.dir, file)
  const createdPrimary = !existsSync(primary)
  const targets = [primary]
  for (const m of isGlobal ? [] : cfg.memoryDirs) {
    if (m.dir === home.dir) continue
    const t = path.join(m.dir, file)
    if (existsSync(t)) targets.push(t)
  }

  const line = `- ${note}`
  const changed = []
  for (const t of targets) {
    const exists = existsSync(t)
    if (!exists && t !== primary) continue // only the session's own dir may gain a new file
    let body = exists ? readFileSync(t, "utf8") : ""
    if (body.includes(line)) continue // idempotent
    if (body && !body.endsWith("\n")) body += "\n"
    writeFileSync(t, body + line + "\n")
    changed.push(t)
  }
  if (changed.length === 0) return { content: "already recorded — no change" }

  let out =
    changed.length > 1
      ? `recorded in ${path.basename(primary)} (all configured projects)`
      : `recorded in ${path.basename(primary)}`

  if (createdPrimary) {
    const idx = readFileSync(idxPath, "utf8")
    if (!idx.includes(`](${file})`)) {
      const label =
        String(title ?? "").trim() ||
        file.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/[-_]/g, " ")
      const summary = note.length > 60 ? ` — ${note.slice(0, 57)}...` : ""
      const entry = `- [${label}](${file})${summary}`
      const anchor = "## Environment-Specific Context\n"
      const next = idx.includes(anchor)
        ? idx.replace(anchor, () => anchor + entry + "\n")
        : idx.replace(/\n*$/, () => `\n${entry}\n`)
      writeFileSync(idxPath, next)
      out += "; indexed in MEMORY.md"
    }
  }
  return { content: out }
}

/** Read the MEMORY.md index for a directory (or undefined when absent). */
export function readIndex(directory, cfg) {
  const match = matchDir(directory, cfg)
  const file = match && path.join(match.dir, "MEMORY.md")
  if (!file || !existsSync(file)) return undefined
  return { file, text: readFileSync(file, "utf8") }
}
