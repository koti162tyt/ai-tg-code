/**
 * Tool definitions the chat model may call, and their server-side execution.
 *
 * The model never touches GitHub directly. It emits a tool call, the server
 * runs it against the configured folder, and the result is fed back as a tool
 * message — the same loop every agent uses, kept small enough for one file.
 *
 * Tool names are prefixed `repo_` so they cannot collide with the model's own
 * vocabulary, and the descriptions state the folder boundary explicitly: a
 * small model follows a stated constraint far more reliably than an implied one.
 *
 * @module lib/tools
 */

import {
  target,
  safePath,
  isTextPath,
  listFiles,
  getFile,
  putFile,
  deleteFile,
  MAX_FILE_BYTES,
} from './github.js'

/** Folder every tool is confined to. */
const FOLDER = process.env.GITHUB_FOLDER || 'chat-files'

/**
 * The tools offered to the model.
 *
 * Kept to four operations: a bigger surface costs prompt tokens on every turn
 * and a small free model starts selecting the wrong one.
 *
 * @returns {Array<object>} OpenAI-shaped tool definitions.
 */
export function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'repo_list',
        description:
          `List the files in the GitHub folder "${FOLDER}". Call this before reading or overwriting a file so you use a path that exists.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `Folder inside the repository. Omit for "${FOLDER}". Must start with "${FOLDER}/".`,
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repo_read',
        description:
          `Read one text file from the GitHub folder "${FOLDER}". Returns the full text. Only text files (md, txt, json, py, js, yaml, csv, html, css) can be read.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `File path starting with "${FOLDER}/", e.g. "${FOLDER}/notes.md".`,
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repo_write',
        description:
          `Create or replace a text file in the GitHub folder "${FOLDER}". This commits to the repository immediately. Always pass the complete new content, not a diff. Read the file first when replacing it.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `File path starting with "${FOLDER}/", e.g. "${FOLDER}/story.md".`,
            },
            text: {
              type: 'string',
              description: 'The complete file content to store.',
            },
            message: {
              type: 'string',
              description: 'Optional commit message.',
            },
          },
          required: ['path', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repo_delete',
        description:
          `Delete a text file from the GitHub folder "${FOLDER}". This commits to the repository immediately and cannot be undone from here. Ask the human to confirm before calling it.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `File path starting with "${FOLDER}/".`,
            },
          },
          required: ['path'],
        },
      },
    },
  ]
}

/**
 * Normalize whatever folder spelling a model produced into a safe path.
 *
 * Small models send ".", "/", "chat-files", "chat-files/" and "" for "the
 * configured folder", and an empty one sometimes arrives as the literal string
 * from the schema example. Each of those means the same thing, so they are
 * folded here instead of being rejected — a rejected listing is the most common
 * reason a tool loop stalls.
 *
 * @param {unknown} raw - the model's path argument.
 * @returns {string} a path that satisfies safePath().
 * @throws when the value names a real folder outside the allowlist.
 */
function folderArg(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '' || value === '.' || value === '/' || value === './') return FOLDER
  const clean = value.replace(/\/+$/, '')
  if (clean === FOLDER) return FOLDER
  if (clean === '.' || clean === '/') return FOLDER
  return safePath(clean, FOLDER)
}

/**
 * Normalize a file-path argument, with a corrective message on failure.
 *
 * A model that passes a bare filename ("notes.md") instead of the full path is
 * the second most common stall after the folder spelling, so the error names
 * the exact expected form rather than echoing GitHub's terse refusal.
 *
 * @param {unknown} raw - the model's path argument.
 * @returns {string} a safe path inside FOLDER.
 * @throws when the value cannot be corrected into the allowlist.
 */
function pathArg(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length === 0) {
    throw new Error(`path is required and must start with "${FOLDER}/"`)
  }
  // A bare filename with no folder prefix means "inside the folder".
  if (!value.includes('/')) return safePath(`${FOLDER}/${value}`, FOLDER)
  try {
    return safePath(value, FOLDER)
  } catch {
    throw new Error(`path "${value}" must start with "${FOLDER}/" (example: "${FOLDER}/notes.md")`)
  }
}

/**
 * Run one tool call.
 *
 * Errors are returned as `{ ok: false, error }` rather than thrown: the model
 * needs to see the failure text to correct itself, and an exception would end
 * the turn instead.
 *
 * @param {object} options
 * @param {string} options.name - tool name from the model.
 * @param {object} options.args - parsed arguments from the model.
 * @returns {Promise<object>} a JSON-safe result for the tool message.
 */
export async function runTool({ name, args }) {
  const token = process.env.GITHUB_TOKEN
  if (!token) return { ok: false, error: 'GITHUB_TOKEN не задан на сервере' }

  try {
    switch (name) {
      case 'repo_list': {
        const path = folderArg(args?.path)
        const entries = await listFiles({ token, path })
        const { owner, repo, branch } = target()
        return {
          ok: true,
          repo: `${owner}/${repo}`,
          branch,
          path,
          files: entries
            .filter((entry) => entry.type === 'file')
            .map((entry) => ({
              path: entry.path,
              bytes: entry.size,
              text: isTextPath(entry.path),
            })),
        }
      }
      case 'repo_read': {
        const path = pathArg(args?.path)
        if (!isTextPath(path)) return { ok: false, error: `"${path}" is not a text file` }
        const file = await getFile({ token, path })
        if (file === undefined) return { ok: false, error: `file "${path}" not found; call repo_list first` }
        return { ok: true, path: file.path, bytes: file.bytes, text: file.text }
      }
      case 'repo_write': {
        const path = pathArg(args?.path)
        if (!isTextPath(path)) return { ok: false, error: `"${path}" is not an allowed text extension` }
        const text = typeof args?.text === 'string' ? args.text : ''
        if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
          return { ok: false, error: `content is over ${MAX_FILE_BYTES} bytes` }
        }
        const result = await putFile({ token, path, text, message: args?.message })
        return { ok: true, ...result }
      }
      case 'repo_delete': {
        const path = pathArg(args?.path)
        const result = await deleteFile({ token, path })
        return { ok: true, ...result }
      }
      default:
        return { ok: false, error: `unknown tool "${name}"` }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) }
  }
}

/**
 * The system prompt that teaches the model its file workflow.
 * @returns {string} prompt text.
 */
export function toolsSystemPrompt() {
  const { owner, repo, branch } = safeTarget()
  return (
    `You are an assistant that can read and write files in the GitHub repository ` +
    `${owner}/${repo} (branch ${branch}), confined to the folder "${FOLDER}".\n\n` +
    `Rules:\n` +
    `- Call repo_list before reading or overwriting, so paths come from the repository.\n` +
    `- Every path starts with "${FOLDER}/". Anything outside it is refused.\n` +
    `- repo_write commits immediately. When replacing a file, read it first and send the complete new text.\n` +
    `- Only text files are allowed: md, txt, json, yaml, py, js, ts, csv, html, css, sql, xml, svg.\n` +
    `- For repo_delete, ask the human to confirm before calling it, then call it only after they agree.\n` +
    `- After writing, tell the human which path changed and summarize what the new content contains.\n` +
    `- If a tool returns an error, read the message and fix the arguments; do not repeat the same failing call.\n` +
    `- Answer in the language the human writes in.`
  )
}

/** target() that never throws, for prompt text. */
function safeTarget() {
  try {
    return target()
  } catch {
    return { owner: '(unset)', repo: '(unset)', branch: 'main' }
  }
}
