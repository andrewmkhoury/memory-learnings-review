import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  clearStaging,
  loadConfig,
  matchDir,
  prepareIndexForInjection,
  readStoreFile,
  resolveScopeDir,
  searchMemory,
  writeNote,
} from "./memory-core.mjs"

// OpenCode plugin: per-project auto-memory recall, search, staging & write path.
//
// Each project maps to a memory directory containing MEMORY.md (the index,
// attached once per session) and topic files (read on demand). Resolution:
//   1. Explicit prefix -> dir mappings from the config file (longest prefix wins).
//   2. If the config sets "baseDir", every project's memory lives under
//      <baseDir>/<slug>/ — fork-store mode.
//   3. Otherwise the Claude Code convention:
//      ~/.claude/projects/<slug>/memory.
//
// Import-free plugin shape: the host provides everything through ctx; no
// runtime npm dependency.
function configFilePath() {
  return (
    process.env.MEMORY_INJECT_CONFIG ??
    path.join(os.homedir(), ".config/opencode/plugins/memory-inject/config.json")
  )
}

// OpenChamber launches its OpenCode sessions with OPENCHAMBER_HOST set; plain
// OpenCode sessions do not have it. That is the scoping signal for the
// OpenChamber-only store.
function isOpenChamber() {
  return Boolean(process.env.OPENCHAMBER_HOST)
}

async function resolveDirectory(ctx: any, context: any): Promise<string | undefined> {
  const sid = context?.sessionID ?? context?.session?.id
  let directory = context?.cwd ?? context?.location?.directory
  if (!directory && sid)
    directory = (await ctx.session.get({ sessionID: sid }))?.location?.directory
  return directory
}

export default {
  id: "memory-inject",
  async setup(ctx: any) {
    // Recall: attach the project memory index (and the global/OC indexes, if
    // configured) once per session, respecting injectIndex and maxIndexBytes.
    await ctx.session.hook("prompt", async (event: any) => {
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        const cfg = loadConfig(configFilePath())
        if (!cfg.injectIndex) return
        const match = matchDir(session?.location?.directory, cfg)
        const projectFile = match ? path.join(match.dir, "MEMORY.md") : undefined
        const globalFile = cfg.globalDir ? path.join(cfg.globalDir, "MEMORY.md") : undefined
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
          const attachPath = prepareIndexForInjection(file, cfg.maxIndexBytes)
          if (!attachPath) continue
          event.prompt.files ??= []
          event.prompt.files.push({ uri: `file://${attachPath}` })
          await ctx.storage.set(key, { at: Date.now() })
        }
      } catch (error) {
        console.error("[memory-inject] failed:", error)
      }
    })

    // Retention + inspection tools.
    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "memory_note",
        description:
          "Record a durable memory (lesson, preference, pitfall, decision) in this project's memory files. " +
          "Appends one bullet to the topic file — and to other configured project dirs when the same file " +
          "exists there — and adds a MEMORY.md index line for new files. Set global: true to write to the " +
          "cross-project global store, openchamber: true for the OpenChamber-only store, or stage: true to " +
          "park an unreviewed candidate in _staging.md mid-session for later curation.",
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
            stage: {
              type: "boolean",
              description:
                "Park as a pending candidate in _staging.md instead of committing to permanent memory",
            },
          },
          required: ["file", "note"],
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          try {
            const directory = await resolveDirectory(ctx, context)
            const cfg = loadConfig(configFilePath())
            return writeNote({
              cfg,
              directory,
              file: String(input?.file ?? "").trim(),
              note: String(input?.note ?? "").replace(/\s*\n\s*/g, " ").trim(),
              title: input?.title,
              isGlobal: input?.global === true,
              isOpenChamber: input?.openchamber === true,
              stage: input?.stage === true,
            })
          } catch (error) {
            return { content: `error: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })

      tools.add({
        name: "memory_search",
        description:
          "Inspect or search memory across project, global, and (in OpenChamber) OpenChamber stores. " +
          "Omit query and file to list all topic files with bullet counts, orphan/bloat flags, and pending " +
          "_staging.md candidates. Pass query to search lines, file to read one topic file, or clearStaging: true " +
          "to clear _staging.md after curating it.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
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
        async execute(input: any, context: any) {
          try {
            const directory = await resolveDirectory(ctx, context)
            const cfg = loadConfig(configFilePath())
            const isGlobal = input?.global === true
            const isOC = input?.openchamber === true

            if (input?.clearStaging === true) {
              return clearStaging({ cfg, directory, isGlobal, isOpenChamber: isOC })
            }
            if (input?.file) {
              const { home, error } = resolveScopeDir({ cfg, directory, isGlobal, isOpenChamber: isOC })
              if (error) return { content: error }
              const res = readStoreFile(home!.dir, String(input.file).trim())
              if (!res) return { content: `error: file not found (${input.file})` }
              return { content: res.text }
            }
            return searchMemory({
              cfg,
              directory,
              query: input?.query,
              includeOpenChamber: isOpenChamber() || isOC,
            })
          } catch (error) {
            return { content: `error: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    })
  },
}
