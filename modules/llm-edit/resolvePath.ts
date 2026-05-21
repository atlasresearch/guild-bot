// Pure path-safety helper used by the per-guild edit tool handlers.
// Per plan 006 R3.3, R3.4, R5.4:
//   1. Reject absolute paths and any path containing `..`.
//   2. Resolve via realpath (follows symlinks).
//   3. Confirm the resolved path is under <guildDir>.
//   4. Reject hardcoded sensitive files (config.json, secrets.json).
//   5. Require a match against the allowlist.

import fsp from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { globMatchAny } from './glob'

export type ResolveOutcome =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; error: string }

const SENSITIVE_FILES = new Set(['config.json', 'secrets.json'])

export type ResolveOptions = {
  /** Path supplied by the LLM. Must be relative; must not contain `..`. */
  filePath: string
  /** Absolute path to the active guild dir. */
  guildDir: string
  /** Operator-configured globs (config.tools.editAllowlist). */
  allowlist: readonly string[]
}

export async function resolveAllowedPath(opts: ResolveOptions): Promise<ResolveOutcome> {
  const { filePath, guildDir, allowlist } = opts

  // 1. Surface-level path checks first — cheaper than syscalls.
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path is required and must be a non-empty string.' }
  }
  if (isAbsolute(filePath)) {
    return { ok: false, error: `file_path "${filePath}" must be relative to the guild dir, not absolute.` }
  }
  if (filePath.split(/[/\\]/).includes('..')) {
    return { ok: false, error: `file_path "${filePath}" must not contain "..".` }
  }

  const absGuildDir = resolve(guildDir)
  const candidateAbs = resolve(absGuildDir, filePath)

  // 2. Follow symlinks; the parent dir must already exist for edit/rewrite,
  //    so we realpath the parent + then re-join the basename. This way we
  //    can also handle the case of writing a NEW file inside an allowlisted
  //    directory (the file itself may not exist yet).
  let realAbs: string
  try {
    realAbs = await fsp.realpath(candidateAbs)
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      // File doesn't exist — realpath the closest existing ancestor and join.
      const parent = candidateAbs.replace(/[/\\][^/\\]+$/, '') || candidateAbs
      try {
        const realParent = await fsp.realpath(parent)
        realAbs = join(realParent, candidateAbs.slice(parent.length + 1))
      } catch {
        return { ok: false, error: `Parent directory of "${filePath}" does not exist.` }
      }
    } else {
      return { ok: false, error: `Unable to resolve file_path "${filePath}": ${e?.message ?? e}` }
    }
  }

  // 3. The resolved path must be under the guild dir.
  const realGuildDir = await fsp.realpath(absGuildDir)
  const rel = relative(realGuildDir, realAbs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `Resolved path escapes the guild dir: "${filePath}" → outside <GUILD_DIR>.` }
  }

  // Normalise to POSIX-style for matching (the in-house glob is POSIX-only).
  const relPosix = rel.split(/\\/).join('/')

  // 4. Hardcoded denylist trumps the allowlist.
  if (SENSITIVE_FILES.has(relPosix)) {
    return {
      ok: false,
      error: `sensitive-file-denied: "${relPosix}" is hardcoded as non-editable by the LLM. Use a typed write API instead.`,
    }
  }

  // 5. Allowlist match.
  if (allowlist.length === 0) {
    return {
      ok: false,
      error: `not-allowlisted: config.tools.editAllowlist is empty. Ask the operator to add "${relPosix}" (or a matching glob) to enable edits.`,
    }
  }
  if (!globMatchAny(allowlist, relPosix)) {
    return {
      ok: false,
      error: `not-allowlisted: "${relPosix}" is not covered by config.tools.editAllowlist (${allowlist.join(', ')}).`,
    }
  }

  return { ok: true, absPath: realAbs, relPath: relPosix }
}
