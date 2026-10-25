/**
 * GitHub Contents API: read, write, list, and delete files in one repository.
 *
 * Only the endpoints this bot needs are wrapped. Every call is a plain fetch
 * against api.github.com with a fine-grained token.
 *
 * The token must be scoped narrowly: a fine-grained PAT limited to the one
 * repository with "Contents: Read and write". A classic `repo` token would grant
 * write access to every repository the account owns, which is far more than a
 * chatbot needs.
 *
 * @module lib/github
 */

/** API root. */
const API = 'https://api.github.com'

/** Refuse to push or read a file larger than this through the contents API. */
export const MAX_FILE_BYTES = 512 * 1024

/** Extensions treated as text; anything else is refused as binary. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.ts', '.jsx', '.tsx',
  '.py', '.html', '.css', '.csv', '.toml', '.ini', '.sh', '.sql', '.xml', '.svg',
])

/**
 * Build the request headers.
 *
 * The API version is pinned to a value GitHub currently accepts. It was
 * "2023-07-01" first, and GitHub retired it: every call then failed with
 * `400 ... is not a supported version`. "2022-11-28" is the old-but-supported
 * baseline, so it keeps working across GitHub's version rollovers.
 *
 * @param {string} token - GitHub token.
 * @returns {Record<string, string>} headers for every call.
 */
function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-tg-code',
    'Content-Type': 'application/json',
  }
}

/**
 * Repository coordinates from the environment.
 * @returns {{owner: string, repo: string, branch: string}} configured target.
 * @throws when the owner or repo is unset.
 */
export function target() {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  if (!owner || !repo) throw new Error('GITHUB_OWNER and GITHUB_REPO must be set')
  return { owner, repo, branch: process.env.GITHUB_BRANCH || 'main' }
}

/**
 * Reject paths that would escape the configured folder or hit hidden config.
 *
 * @param {string} path - caller-supplied path.
 * @param {string} [prefix] - required folder prefix.
 * @returns {string} the normalized path.
 */
export function safePath(path, prefix) {
  const clean = String(path ?? '').trim().replace(/^\/+/, '')
  if (clean.length === 0) throw new Error('path is required')
  if (clean.includes('..')) throw new Error('path must not contain ".."')
  if (clean.split('/').some((segment) => segment.startsWith('.'))) {
    throw new Error('path must not contain dot-segments')
  }
  if (prefix) {
    const want = prefix.replace(/^\/+|\/+$/g, '')
    if (want.length > 0 && !clean.startsWith(`${want}/`)) {
      throw new Error(`path must start with "${want}/"`)
    }
  }
  return clean
}

/**
 * Whether a filename looks like text this bot should handle.
 * @param {string} path - file path.
 * @returns {boolean} true for the allowlisted extensions.
 */
export function isTextPath(path) {
  const index = path.lastIndexOf('.')
  if (index < 0) return false
  return TEXT_EXTENSIONS.has(path.slice(index).toLowerCase())
}

/**
 * Read one file.
 *
 * @param {object} options
 * @param {string} options.token - GitHub token.
 * @param {string} options.path - file path inside the repository.
 * @returns {Promise<{path: string, text: string, sha: string, bytes: number}|undefined>}
 *   the file, or undefined when it does not exist.
 */
export async function getFile({ token, path }) {
  const { owner, repo, branch } = target()
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`
  const response = await fetch(url, { headers: headers(token) })
  if (response.status === 404) return undefined
  if (!response.ok) throw await apiError('read', response)

  const data = await response.json()
  if (Array.isArray(data)) throw new Error(`"${path}" is a directory, not a file`)
  if (data.type !== 'file') throw new Error(`"${path}" is a ${data.type}, not a file`)
  if (data.size > MAX_FILE_BYTES) {
    throw new Error(`file is ${data.size} bytes; the limit is ${MAX_FILE_BYTES}`)
  }
  if (data.encoding !== 'base64') {
    throw new Error(`"${path}" is not accessible as text (encoding: ${data.encoding})`)
  }

  const text = Buffer.from(data.content ?? '', 'base64').toString('utf8')
  return { path: data.path, text, sha: data.sha, bytes: data.size }
}

/**
 * List one directory.
 *
 * @param {object} options
 * @param {string} options.token - GitHub token.
 * @param {string} [options.path] - directory path; empty means repository root.
 * @returns {Promise<Array<{name: string, path: string, type: string, size: number}>>}
 *   the directory entries, files and directories both included.
 */
export async function listFiles({ token, path }) {
  const { owner, repo, branch } = target()
  const suffix = path ? `/${encodeURI(path)}` : ''
  const url = `${API}/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(branch)}`
  const response = await fetch(url, { headers: headers(token) })
  if (response.status === 404) return []
  if (!response.ok) throw await apiError('list', response)

  const data = await response.json()
  if (!Array.isArray(data)) throw new Error(`"${path ?? ''}" is a file, not a directory`)
  return data.map((entry) => ({
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size ?? 0,
  }))
}

/**
 * Create or replace one text file.
 *
 * An existing file needs its current blob sha, so this reads first and passes
 * the sha on update. GitHub rejects an update without it (`422`).
 *
 * @param {object} options
 * @param {string} options.token - GitHub token.
 * @param {string} options.path - file path inside the repository.
 * @param {string} options.text - new file content.
 * @param {string} [options.message] - commit message.
 * @returns {Promise<{path: string, sha: string, created: boolean, url: string}>}
 *   the resulting file.
 */
export async function putFile({ token, path, text, message }) {
  if (typeof text !== 'string') throw new Error('text must be a string')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`content is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}`)
  }

  const { owner, repo, branch } = target()
  const existing = await getFile({ token, path })
  const body = {
    message: message || `${existing ? 'Update' : 'Add'} ${path}`,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch,
  }
  if (existing) body.sha = existing.sha

  const response = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await apiError('write', response)

  const data = await response.json()
  return {
    path: data.content?.path ?? path,
    sha: data.content?.sha ?? '',
    created: Boolean(existing) === false,
    url: data.content?.html_url ?? '',
  }
}

/**
 * Delete one file.
 *
 * @param {object} options
 * @param {string} options.token - GitHub token.
 * @param {string} options.path - file path to delete.
 * @param {string} [options.message] - commit message.
 * @returns {Promise<{path: string, deleted: boolean}>} the outcome.
 */
export async function deleteFile({ token, path, message }) {
  const existing = await getFile({ token, path })
  if (!existing) return { path, deleted: false }

  const { owner, repo, branch } = target()
  const response = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'DELETE',
    headers: headers(token),
    body: JSON.stringify({
      message: message || `Delete ${path}`,
      sha: existing.sha,
      branch,
    }),
  })
  if (!response.ok) throw await apiError('delete', response)
  return { path, deleted: true }
}

/**
 * Turn a failed response into an Error carrying GitHub's own explanation.
 * @param {string} operation - what was attempted, for the message.
 * @param {Response} response - the failed response.
 * @returns {Promise<Error>} an error with status and message.
 */
async function apiError(operation, response) {
  let detail = ''
  try {
    const body = await response.json()
    detail = body?.message ?? ''
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      detail += ` (${body.errors.map((e) => e.message ?? e.code).join(', ')})`
    }
  } catch {
    detail = await response.text().catch(() => '')
  }
  if (response.status === 401) return new Error(`GitHub ${operation}: токен неверный или истёк (401)`)
  if (response.status === 403) {
    return new Error(`GitHub ${operation}: нет прав (403). Нужен scope Contents: Read and write. ${detail}`)
  }
  if (response.status === 404) return new Error(`GitHub ${operation}: репозиторий или файл не найден (404)`)
  return new Error(`GitHub ${operation}: ${response.status} ${detail}`.slice(0, 400))
}
