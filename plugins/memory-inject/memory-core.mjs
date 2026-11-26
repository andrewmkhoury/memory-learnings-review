// Shared memory-store logic for the memory-inject system. Pure Node, no
// dependencies, used by both the OpenCode plugin (index.ts) and the MCP
// server (memory-mcp.mjs). Sync I/O is fine: files are small and local.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const STAGING_FILE = "_staging.md"
export const DEFAULT_MAX_INDEX_BYTES = 4096
const MAX_SEARCH_MATCHES = 30
const SNIPPET_MAX_CHARS = 240

export function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

export function slugFor(directory) {
  return directory.replace(/\//g, "-")
}

/** Detect ephemeral OpenChamber standalone chat folders that no future session will revisit. */
export function isEphemeralSessionDir(directory) {
  if (!directory) return false
  return /\/openchamber\/chats\/[^/]+\/session-[^/]+(?:\/|$)/.test(directory)
}

/** @returns {{memoryDirs: Array<{prefix:string,dir:string}>, baseDir?: string, globalDir?: string, openchamberDir?: string, injectIndex: boolean, maxIndexBytes: number}} */
export function loadConfig(cfgPath) {
  const defaults = {
    memoryDirs: [],
    injectIndex: true,
    maxIndexBytes: DEFAULT_MAX_INDEX_BYTES,
  }
  let raw
  try {
    raw = readFileSync(cfgPath, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error(`[memory-inject] ignoring unreadable config ${cfgPath}:`, error)
    return defaults
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(`[memory-inject] ignoring invalid config ${cfgPath}:`, error)
    return defaults
  }
  const memoryDirs = (parsed.memoryDirs ?? [])
    .filter((m) => typeof m.prefix === "string" && typeof m.dir === "string")
    .map((m) => ({ prefix: expand(m.prefix), dir: expand(m.dir) }))
    // Longest prefix first so nested project mappings always beat parent dirs.
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const baseDir = typeof parsed.baseDir === "string" ? expand(parsed.baseDir) : undefined
  const globalDir = typeof parsed.globalDir === "string" ? expand(parsed.globalDir) : undefined
  const openchamberDir =
    typeof parsed.openchamberDir === "string" ? expand(parsed.openchamberDir) : undefined
  const injectIndex = typeof parsed.injectIndex === "boolean" ? parsed.injectIndex : true
  const maxIndexBytes =
    typeof parsed.maxIndexBytes === "number" && parsed.maxIndexBytes > 0
      ? Math.floor(parsed.maxIndexBytes)
      : DEFAULT_MAX_INDEX_BYTES
  return { memoryDirs, baseDir, globalDir, openchamberDir, injectIndex, maxIndexBytes }
}

/**
 * Return the path to attach for a MEMORY.md file on first prompt.
 * - If within `maxIndexBytes`, returns the original file path unchanged.
 * - If larger, writes a compact title-only index (<= maxIndexBytes) in tmpdir
 *   so turn-1 context never blows up.
 */
export function prepareIndexForInjection(indexPath, maxIndexBytes = DEFAULT_MAX_INDEX_BYTES) {
  if (!indexPath || !existsSync(indexPath)) return undefined
  const raw = readFileSync(indexPath, "utf8")
  if (Buffer.byteLength(raw, "utf8") <= maxIndexBytes) return indexPath

  const footer = "\n<!-- compacted for turn-1 budget; call memory_search for details -->\n"
  const budget = Math.max(256, maxIndexBytes - Buffer.byteLength(footer, "utf8"))
  const compactLines = []
  let used = 0
  for (const line of raw.split("\n")) {
    // Strip verbose " — summary..." descriptions from index bullets.
    const slim = line.replace(/^(\s*-\s+\[[^\]]+\]\([^)]+\))\s+[—–-]\s+.*$/, "$1")
    const bytes = Buffer.byteLength(slim + "\n", "utf8")
    if (used + bytes > budget) break
    compactLines.push(slim)
    used += bytes
  }
  const out = compactLines.join("\n").trimEnd() + footer
  const hash = createHash("sha1").update(indexPath).digest("hex").slice(0, 12)
  const compactPath = path.join(os.tmpdir(), `memory-inject-compact-${hash}.md`)
  writeFileSync(compactPath, out)
  return compactPath
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

/**
 * Resolve the target store directory for project / global / openchamber scopes.
 * @returns {{home?: {prefix:string,dir:string}, error?: string}}
 */
export function resolveScopeDir({ cfg, directory, isGlobal = false, isOpenChamber = false }) {
  if (isOpenChamber) {
    if (!cfg.openchamberDir)
      return {
        error: "error: OpenChamber store not configured (set openchamberDir in the plugin config)",
      }
    return { home: { prefix: "", dir: cfg.openchamberDir } }
  }
  if (isGlobal) {
    if (!cfg.globalDir)
      return { error: "error: global store not configured (set globalDir in the plugin config)" }
    return { home: { prefix: "", dir: cfg.globalDir } }
  }
  const normalized = directory ? expand(directory) : undefined
  if (isEphemeralSessionDir(normalized)) {
    return {
      error:
        "error: session directory is an ephemeral chat folder — pass 'directory' pointing to the actual project repo (or use global: true / openchamber: true)",
    }
  }
  const home = matchDir(normalized, cfg)
  if (!home) return { error: "error: no memory directory mapped for this session's directory" }
  return { home }
}

const SECRET_PATTERNS = [
  { label: "GitHub token", re: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  { label: "API key (sk-)", re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { label: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
]

export function detectSecret(text) {
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) return label
  }
  return undefined
}

const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "were", "been", "when", "what", "into",
  "only", "also", "more", "than", "then", "them", "they", "their", "your", "about",
  "should", "would", "could", "always", "never", "using", "before", "after",
])

function contentTokens(text) {
  const tokens = text.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []
  return new Set(tokens.filter((t) => !STOP_WORDS.has(t)))
}

function findNearDuplicateLine(body, note) {
  const noteTokens = contentTokens(note)
  if (noteTokens.size < 4) return undefined
  const lines = body.split("\n")
  let best = undefined
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+(.*)$/)
    if (!m) continue
    const existingTokens = contentTokens(m[1])
    if (existingTokens.size < 4) continue
    let inter = 0
    for (const t of noteTokens) if (existingTokens.has(t)) inter++
    const union = noteTokens.size + existingTokens.size - inter
    const sim = union > 0 ? inter / union : 0
    if (sim >= 0.65 && (!best || sim > best.sim)) {
      best = { line: i + 1, sim }
    }
  }
  return best?.line
}

export function validateTopicFilename(file) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(file))
    return "error: file must be a plain basename like 40-topic-name.md"
  if (file === "MEMORY.md")
    return "error: MEMORY.md is managed automatically — write to a topic file instead"
  return undefined
}

export function validateNote(file, note) {
  const fileErr = validateTopicFilename(file)
  if (fileErr) return fileErr
  if (!note) return "error: note is required"
  if (note.length > 500)
    return "error: note too long (max 500 chars) — keep it to one tight bullet"
  const secret = detectSecret(note)
  if (secret) return `error: note appears to contain a secret (${secret}) — remove credentials before saving`
  return undefined
}

/**
 * Append a lightweight candidate learning to _staging.md (not indexed in
 * MEMORY.md) for later curation by memory-learnings-review.
 * @returns {{content: string}}
 */
export function stageNote({ cfg, directory, note, file, isGlobal = false, isOpenChamber = false }) {
  if (!note) return { content: "error: note is required" }
  if (note.length > 500)
    return { content: "error: note too long (max 500 chars) — keep it to one tight bullet" }
  const secret = detectSecret(note)
  if (secret) return { content: `error: note appears to contain a secret (${secret}) — remove credentials before saving` }
  if (file) {
    const fileErr = validateTopicFilename(file)
    if (fileErr) return { content: fileErr }
  }
  const { home, error } = resolveScopeDir({ cfg, directory, isGlobal, isOpenChamber })
  if (error) return { content: error }

  mkdirSync(home.dir, { recursive: true })
  const stagingPath = path.join(home.dir, STAGING_FILE)
  const hint = file ? ` [target: ${file}]` : ""
  const line = `- ${note}${hint}`
  let body = existsSync(stagingPath) ? readFileSync(stagingPath, "utf8") : ""
  if (body.includes(line)) return { content: "already staged — no change" }
  if (body && !body.endsWith("\n")) body += "\n"
  writeFileSync(stagingPath, body + line + "\n")
  return { content: `staged in ${STAGING_FILE} (pending review)` }
}

/**
 * Clear _staging.md after curation.
 * @returns {{content: string}}
 */
export function clearStaging({ cfg, directory, isGlobal = false, isOpenChamber = false }) {
  const { home, error } = resolveScopeDir({ cfg, directory, isGlobal, isOpenChamber })
  if (error) return { content: error }
  const stagingPath = path.join(home.dir, STAGING_FILE)
  if (!existsSync(stagingPath)) return { content: "staging already empty" }
  unlinkSync(stagingPath)
  return { content: `cleared ${STAGING_FILE}` }
}

/**
 * Append one bullet to a topic file (and to sibling configured projects that
 * already have it), indexing new files in MEMORY.md. Idempotent.
 * @returns {{content: string}}
 */
export function writeNote({
  cfg,
  directory,
  file,
  note,
  title,
  isGlobal = false,
  isOpenChamber = false,
  stage = false,
}) {
  if (stage) return stageNote({ cfg, directory, note, file, isGlobal, isOpenChamber })

  const validation = validateNote(file, note)
  if (validation) return { content: validation }

  const { home, error } = resolveScopeDir({ cfg, directory, isGlobal, isOpenChamber })
  if (error) return { content: error }

  mkdirSync(home.dir, { recursive: true })
  const idxPath = path.join(home.dir, "MEMORY.md")
  if (!existsSync(idxPath))
    writeFileSync(idxPath, "# Memory index\n\n## Environment-Specific Context\n")
  const primary = path.join(home.dir, file)
  const createdPrimary = !existsSync(primary)
  const targets = [primary]
  for (const m of isGlobal || isOpenChamber ? [] : cfg.memoryDirs) {
    if (m.dir === home.dir) continue
    const t = path.join(m.dir, file)
    if (existsSync(t)) targets.push(t)
  }

  const line = `- ${note}`
  const changed = []
  let nearDupLine = undefined
  for (const t of targets) {
    const exists = existsSync(t)
    if (!exists && t !== primary) continue // only the session's own dir may gain a new file
    let body = exists ? readFileSync(t, "utf8") : ""
    if (body.includes(line)) continue // idempotent
    if (t === primary && body) nearDupLine = findNearDuplicateLine(body, note)
    if (body && !body.endsWith("\n")) body += "\n"
    writeFileSync(t, body + line + "\n")
    changed.push(t)
  }
  if (changed.length === 0) return { content: "already recorded — no change" }

  let out =
    changed.length > 1
      ? `recorded in ${path.basename(primary)} (all configured projects)`
      : `recorded in ${path.basename(primary)}`
  if (nearDupLine !== undefined) {
    out += `; warning: similar to existing bullet on line ${nearDupLine} — consider merging`
  }

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

/** Read a specific markdown file (MEMORY.md, _staging.md, or topic file) inside a store dir. */
export function readStoreFile(dir, file) {
  if (!dir || !existsSync(dir)) return undefined
  if (file !== "MEMORY.md" && file !== STAGING_FILE) {
    if (validateTopicFilename(file)) return undefined
  }
  const full = path.join(dir, file)
  if (!existsSync(full)) return undefined
  return { file: full, text: readFileSync(full, "utf8") }
}

function collectScopes({ cfg, directory, includeOpenChamber = false }) {
  const scopes = []
  const normalized = directory ? expand(directory) : undefined
  const project = !isEphemeralSessionDir(normalized) ? matchDir(normalized, cfg) : undefined
  if (project && existsSync(project.dir)) scopes.push({ scope: "project", dir: project.dir })
  if (cfg.globalDir && existsSync(cfg.globalDir)) scopes.push({ scope: "global", dir: cfg.globalDir })
  if (includeOpenChamber && cfg.openchamberDir && existsSync(cfg.openchamberDir))
    scopes.push({ scope: "openchamber", dir: cfg.openchamberDir })
  return scopes
}

function formatSnippet(line, queryLower) {
  if (line.length <= SNIPPET_MAX_CHARS) return line
  const idx = line.toLowerCase().indexOf(queryLower)
  const half = Math.floor((SNIPPET_MAX_CHARS - queryLower.length) / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(line.length, start + SNIPPET_MAX_CHARS)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < line.length ? "…" : ""
  return prefix + line.slice(start, end) + suffix
}

/**
 * Inspect or search memory across project, global, and (optionally) openchamber stores.
 * - With `query`: case-insensitive substring search across all topic files + _staging.md
 *   with snippet truncation for long lines.
 * - Without `query`: inventory of topic files with bullet counts, orphan/bloat/duplicate flags,
 *   and pending staged candidates.
 * @returns {{content: string}}
 */
export function searchMemory({ cfg, directory, query, includeOpenChamber = false }) {
  const scopes = collectScopes({ cfg, directory, includeOpenChamber })
  if (scopes.length === 0) return { content: "no memory stores found for this directory" }

  const q = String(query ?? "").trim().toLowerCase()
  const out = []

  if (!q) {
    // Track which topic basenames appear in multiple active scopes.
    const seenInScopes = new Map()
    for (const { scope, dir } of scopes) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md") || f === "MEMORY.md" || f === STAGING_FILE) continue
        const set = seenInScopes.get(f) ?? new Set()
        set.add(scope)
        seenInScopes.set(f, set)
      }
    }

    for (const { scope, dir } of scopes) {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
      const idxPath = path.join(dir, "MEMORY.md")
      const idxText = existsSync(idxPath) ? readFileSync(idxPath, "utf8") : ""
      out.push(`[${scope}] ${dir}`)
      const topics = files.filter((f) => f !== "MEMORY.md" && f !== STAGING_FILE)
      if (topics.length === 0) {
        out.push("  (no topic files)")
      } else {
        for (const f of topics) {
          const full = path.join(dir, f)
          const text = readFileSync(full, "utf8")
          const bullets = text.split("\n").filter((l) => /^\s*-\s+/.test(l)).length
          const bytes = statSync(full).size
          const indexed = idxText.includes(`](${f})`)
          const flags = []
          if (!indexed) flags.push("unindexed")
          if (bullets >= 25 || bytes >= 8192) flags.push("large — consider compacting")
          const otherScopes = [...(seenInScopes.get(f) ?? [])].filter((s) => s !== scope)
          if (otherScopes.length > 0) flags.push(`also in ${otherScopes.join(", ")}`)
          const sizeStr = bytes >= 4096 ? `, ${(bytes / 1024).toFixed(1)} KB` : ""
          const suffix = flags.length ? ` (${flags.join(", ")})` : ""
          out.push(`  - ${f}: ${bullets} bullets${sizeStr}${suffix}`)
        }
      }
      const stagingPath = path.join(dir, STAGING_FILE)
      if (existsSync(stagingPath)) {
        const staged = readFileSync(stagingPath, "utf8")
          .split("\n")
          .filter((l) => /^\s*-\s+/.test(l))
        if (staged.length > 0) {
          out.push(`  - ${STAGING_FILE}: ${staged.length} pending candidate(s)`)
          for (const line of staged) out.push(`      ${line}`)
        }
      }
    }
    return { content: out.join("\n") }
  }

  let matches = 0
  for (const { scope, dir } of scopes) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort()
    for (const f of files) {
      const lines = readFileSync(path.join(dir, f), "utf8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          out.push(`[${scope}] ${f}:${i + 1}: ${formatSnippet(lines[i], q)}`)
          matches++
          if (matches >= MAX_SEARCH_MATCHES) {
            out.push(`... (truncated at ${MAX_SEARCH_MATCHES} matches)`)
            return { content: out.join("\n") }
          }
        }
      }
    }
  }
  return { content: matches === 0 ? `no matches for "${query.trim()}"` : out.join("\n") }
}
