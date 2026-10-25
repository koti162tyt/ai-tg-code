/**
 * /api/files — list, read, write and delete repository files.
 *
 * This is the file surface the chat uses: the model proposes a tool call, the
 * page executes it here, and the result goes back into the conversation. It is
 * also usable on its own (curl) for setup and inspection.
 *
 * Auth: `x-admin-token` must equal ADMIN_TOKEN — the same barrier as /api/chat.
 * Every operation is confined to GITHUB_FOLDER (default "chat-files") and to
 * the text extensions in lib/github.js: a chatbot must not be able to rewrite
 * the bot's own source or commit binaries.
 *
 * Routes:
 *   GET    /api/files?path=DIR&token=...      list a directory
 *   GET    /api/files?path=FILE&read=1        read one file
 *   POST   /api/files  {path, text, message}  create or replace a file
 *   DELETE /api/files?path=FILE               delete a file
 *
 * @module api/files
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
} from '../lib/github.js'
import { presentedToken, tokenMatches, deny, jsonBody } from '../lib/http.js'

/** Folder every operation is confined to. */
const FOLDER = process.env.GITHUB_FOLDER || 'chat-files'

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export default async function handler(request, response) {
  const presented = presentedToken(request)
  if (!tokenMatches(presented, process.env.ADMIN_TOKEN)) return deny(response, presented)

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return response.status(200).json({ ok: false, error: 'GITHUB_TOKEN не задан в переменных окружения' })
  }

  const url = new URL(String(request.url ?? '/'), 'http://local')
  const rawPath = url.searchParams.get('path') ?? ''

  try {
    if (request.method === 'GET') {
      const path = rawPath.length === 0 ? FOLDER : safePath(rawPath, FOLDER)
      if (url.searchParams.get('read') === '1') return await readOne({ response, token, path })
      return await list({ response, token, path })
    }
    if (request.method === 'POST') return await writeOne({ request, response, token })
    if (request.method === 'DELETE') return await removeOne({ response, token, path: rawPath })

    response.setHeader('Allow', 'GET, POST, DELETE')
    return response.status(405).json({ ok: false, error: 'GET, POST or DELETE' })
  } catch (error) {
    return response.status(200).json({ ok: false, error: describe(error) })
  }
}

/** List a directory, with the configured target echoed for orientation. */
async function list({ response, token, path }) {
  const entries = await listFiles({ token, path })
  const { owner, repo, branch } = target()
  const files = entries.filter((entry) => entry.type === 'file' && isTextPath(entry.path))
  return response.status(200).json({
    ok: true,
    repo: `${owner}/${repo}`,
    branch,
    folder: FOLDER,
    path,
    entries,
    textFiles: files.length,
  })
}

/** Read one file's text. */
async function readOne({ response, token, path: rawPath }) {
  const path = safePath(rawPath, FOLDER)
  if (!isTextPath(path)) {
    return response.status(200).json({ ok: false, error: `"${path}" не текстовый файл (разрешены: md, txt, json, py, js, yaml …)` })
  }
  const file = await getFile({ token, path })
  if (file === undefined) return response.status(200).json({ ok: false, error: `файл "${path}" не найден` })
  return response.status(200).json({
    ok: true,
    path: file.path,
    bytes: file.bytes,
    lines: file.text.split(/\r?\n/).length,
    text: file.text,
  })
}

/** Create or replace one file. */
async function writeOne({ request, response, token }) {
  const body = jsonBody(request)
  const path = safePath(body?.path, FOLDER)
  if (!isTextPath(path)) {
    return response.status(200).json({ ok: false, error: `"${path}" не текстовый файл` })
  }
  const text = typeof body?.text === 'string' ? body.text : ''
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return response.status(200).json({ ok: false, error: `файл больше ${MAX_FILE_BYTES} байт` })
  }
  const result = await putFile({ token, path, text, message: body?.message })
  return response.status(200).json({ ok: true, ...result })
}

/** Delete one file. */
async function removeOne({ response, token, path: rawPath }) {
  const path = safePath(rawPath, FOLDER)
  const result = await deleteFile({ token, path })
  return response.status(200).json({ ok: true, ...result })
}

/** Turn any thrown error into a sentence for the chat. */
function describe(error) {
  const message = String(error?.message ?? error)
  if (/401/.test(message)) return 'GitHub-токен неверный или истёк (401)'
  if (/403/.test(message)) return 'у токена нет прав на запись (403). Нужен scope Contents: Read and write'
  if (/404/.test(message)) return 'репозиторий или файл не найден (404). Проверь GITHUB_OWNER и GITHUB_REPO'
  return message.slice(0, 300)
}
