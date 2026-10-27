import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// OpenCode plugin: per-project auto-memory recall + write path.
//
// Each project maps to a memory directory containing MEMORY.md (the index,
// attached once per session) and topic files (read on demand). Resolution:
//   1. Explicit prefix -> dir mappings from the config file.
//   2. If the config sets "baseDir", every project's memory lives under
//      <baseDir>/<slug>/ — this is how a fork of this repo can act as the
//      user's own version-controlled memory store.
//   3. Otherwise the Claude Code convention:
//      <claudeHome>/projects/<slug>/memory, where <slug> is the session's
//      absolute working directory with "/" replaced by "-".
//
// Import-free plugin shape: the host provides everything through ctx; no
// runtime npm dependency.
const CLAUDE_HOME = path.join(os.homedir(), ".claude")
// Config location; MEMORY_INJECT_CONFIG overrides (used by the test harness
// and by anyone who keeps the plugin outside the default plugin directory).
// Read per call so a relocated config is picked up without a restart.
function configFilePath() {
  return (
    process.env.MEMORY_INJECT_CONFIG ??
    path.join(os.homedir(), ".config/opencode/plugins/memory-inject/config.json")
  )
}

interface Mapping { prefix: string; dir: string }
interface Config {
  memoryDirs: Mapping[]
  baseDir?: string
  globalDir?: string
  openchamberDir?: string
}

// OpenChamber launches its OpenCode sessions with OPENCHAMBER_HOST set; plain
// OpenCode sessions do not have it. That is the scoping signal for the
// OpenChamber-only store.
function isOpenChamber() {
  return Boolean(process.env.OPENCHAMBER_HOST)
}

function expand(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function slugFor(directory: string) {
  return directory.replace(/\//g, "-")
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(configFilePath(), "utf8")
    const parsed = JSON.parse(raw) as {
      memoryDirs?: Mapping[]
      baseDir?: string
      globalDir?: string
      openchamberDir?: string
    }
    const memoryDirs = (parsed.memoryDirs ?? [])
      .filter((m) => typeof m.prefix === "string" && typeof m.dir === "string")
      .map((m) => ({ prefix: expand(m.prefix), dir: expand(m.dir) }))
    const baseDir = typeof parsed.baseDir === "string" ? expand(parsed.baseDir) : undefined
    const globalDir = typeof parsed.globalDir === "string" ? expand(parsed.globalDir) : undefined
    const openchamberDir =
      typeof parsed.openchamberDir === "string" ? expand(parsed.openchamberDir) : undefined
    return { memoryDirs, baseDir, globalDir, openchamberDir }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
      console.error(`[memory-inject] ignoring unreadable config ${configFilePath()}:`, error)
    return { memoryDirs: [] }
  }
}

function matchDir(directory: string | undefined, cfg: Config): Mapping | undefined {
  if (!directory) return undefined
  const explicit = cfg.memoryDirs.find(
    (m) => directory === m.prefix || directory.startsWith(`${m.prefix}/`),
  )
  if (explicit) return explicit
  const slug = slugFor(directory)
  // Fork store: <baseDir>/<slug>, else the Claude Code convention.
  const dir = cfg.baseDir
    ? path.join(cfg.baseDir, slug)
    : path.join(CLAUDE_HOME, "projects", slug, "memory")
  return { prefix: directory, dir }
}

export default {
  id: "memory-inject",
  async setup(ctx: any) {
    // Recall: attach the project memory index (and the global index, if
    // configured) once per session.
    await ctx.session.hook("prompt", async (event: any) => {
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        const cfg = await loadConfig()
        const match = matchDir(session?.location?.directory, cfg)
        const projectFile = match ? path.join(match.dir, "MEMORY.md") : undefined
        const globalFile = cfg.globalDir ? path.join(cfg.globalDir, "MEMORY.md") : undefined
        // OpenChamber-only store: attached in OpenChamber sessions only.
        const ocFile =
          isOpenChamber() && cfg.openchamberDir
            ? path.join(cfg.openchamberDir, "MEMORY.md")
            : undefined
        for (const [key, file] of [
          [`memory-injected:${event.sessionID}`, projectFile],
          [`memory-injected:global:${event.sessionID}`, globalFile],
          [`memory-injected:openchamber:${event.sessionID}`, ocFile],
        ] as const) {
          if (!file || !existsSync(file)) continue
          if ((await ctx.storage.get(key)) !== undefined) continue
          event.prompt.files ??= []
          event.prompt.files.push({ uri: `file://${file}` })
          await ctx.storage.set(key, { at: Date.now() })
        }
      } catch (error) {
        console.error("[memory-inject] failed:", error)
      }
    })

    // Retention: append durable memories to the topic files.
    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "memory_note",
        description:
          "Record a durable memory (lesson, preference, pitfall, decision) in this project's memory files. " +
          "Appends one bullet to the topic file — and to other configured project dirs when the same file " +
          "exists there — and adds a MEMORY.md index line for new files. Set global: true to write to the " +
          "cross-project global store, or openchamber: true to write to the OpenChamber-only store " +
          "(injected into OpenChamber sessions only). Use when you learn something worth keeping beyond this session.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
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
              description:
                "Write to the OpenChamber store instead of this project's store (only injected into OpenChamber sessions)",
            },
          },
          required: ["file", "note"],
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          try {
            const file = String(input?.file ?? "").trim()
            const note = String(input?.note ?? "").replace(/\s*\n\s*/g, " ").trim()
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(file))
              return { content: "error: file must be a plain basename like 40-topic-name.md" }
            if (!note) return { content: "error: note is required" }
            if (note.length > 500)
              return { content: "error: note too long (max 500 chars) — keep it to one tight bullet" }

            const sid = context?.sessionID ?? context?.session?.id
            let directory = context?.cwd ?? context?.location?.directory
            if (!directory && sid)
              directory = (await ctx.session.get({ sessionID: sid }))?.location?.directory
            const cfg = await loadConfig()
            const isGlobal = input?.global === true
            const isOC = input?.openchamber === true
            let home: Mapping | undefined
            if (isOC) {
              if (!cfg.openchamberDir)
                return {
                  content: "error: OpenChamber store not configured (set openchamberDir in the plugin config)",
                }
              home = { prefix: "", dir: cfg.openchamberDir }
            } else if (isGlobal) {
              if (!cfg.globalDir)
                return { content: "error: global store not configured (set globalDir in the plugin config)" }
              home = { prefix: "", dir: cfg.globalDir }
            } else {
              home = matchDir(directory, cfg)
              if (!home)
                return { content: "error: no memory directory mapped for this session's directory" }
            }

            await mkdir(home.dir, { recursive: true })
            const idxBootstrap = path.join(home.dir, "MEMORY.md")
            if (!existsSync(idxBootstrap))
              await writeFile(idxBootstrap, "# Memory index\n\n## Environment-Specific Context\n")
            const primary = path.join(home.dir, file)
            const createdPrimary = !existsSync(primary)
            const targets = [primary]
            // Explicitly configured sibling projects keep shared topic files in sync.
            for (const m of isGlobal || isOC ? [] : cfg.memoryDirs) {
              if (m.dir === home.dir) continue
              const t = path.join(m.dir, file)
              if (existsSync(t)) targets.push(t)
            }

            const line = `- ${note}`
            const changed: string[] = []
            for (const t of targets) {
              const exists = existsSync(t)
              if (!exists && t !== primary) continue // only the session's own dir may gain a new file
              let body = exists ? await readFile(t, "utf8") : ""
              if (body.includes(line)) continue // idempotent
              if (body && !body.endsWith("\n")) body += "\n"
              await writeFile(t, body + line + "\n")
              changed.push(t)
            }
            if (changed.length === 0) return { content: "already recorded — no change" }

            let out =
              changed.length > 1
                ? `recorded in ${path.basename(primary)} (all configured projects)`
                : `recorded in ${path.basename(primary)}`

            if (createdPrimary) {
              const idxPath = path.join(home.dir, "MEMORY.md")
              const idx = await readFile(idxPath, "utf8")
              if (!idx.includes(`](${file})`)) {
                const label =
                  String(input?.title ?? "").trim() ||
                  file.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/[-_]/g, " ")
                const summary = note.length > 60 ? ` — ${note.slice(0, 57)}...` : ""
                const entry = `- [${label}](${file})${summary}`
                const anchor = "## Environment-Specific Context\n"
                const next = idx.includes(anchor)
                  ? idx.replace(anchor, () => anchor + entry + "\n")
                  : idx.replace(/\n*$/, () => `\n${entry}\n`)
                await writeFile(idxPath, next)
                out += "; indexed in MEMORY.md"
              }
            }
            return { content: out }
          } catch (error) {
            return { content: `error: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    })
  },
}
