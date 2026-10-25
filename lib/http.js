/**
 * Shared HTTP helpers for the browser-facing endpoints.
 *
 * The page and its API live on the same origin, so the browser sends no CORS
 * preflight. Every browser endpoint still requires the admin token: the deploy
 * domain is public, and an open LLM endpoint would burn the daily quota for
 * anyone who found it.
 *
 * @module lib/http
 */

/**
 * Read the bearer token a browser request carries.
 *
 * Accepted from the `x-admin-token` header (used by the page's fetch calls) or
 * from a `token` query parameter (used by nothing in the shipped page, but handy
 * for curl during setup).
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {string|undefined} the presented token, if any.
 */
export function presentedToken(request) {
  const header = request.headers?.['x-admin-token']
  if (typeof header === 'string' && header.length > 0) return header
  const query = String(request.url ?? '').split('?')[1]
  if (!query) return undefined
  const value = new URLSearchParams(query).get('token')
  return value ?? undefined
}

/**
 * Compare the presented token with ADMIN_TOKEN in constant time.
 *
 * A plain `===` leaks the matching prefix length through timing. The lengths
 * are compared first (that is not secret), then the bytes are accumulated into
 * one result so no early exit reveals where the mismatch was.
 *
 * @param {string|undefined} presented - token from the request.
 * @param {string|undefined} expected - ADMIN_TOKEN from the environment.
 * @returns {boolean} whether the request may proceed.
 */
export function tokenMatches(presented, expected) {
  if (!expected || typeof presented !== 'string') return false
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return diff === 0
}

/**
 * Refuse a request: `401` when no token was presented, `403` when it is wrong.
 * @param {object} response - Vercel-style response.
 * @param {string|undefined} presented - what the client sent.
 * @returns {object} the response, already ended.
 */
export function deny(response, presented) {
  const status = presented === undefined ? 401 : 403
  return response.status(status).json({
    ok: false,
    error: status === 401 ? 'ADMIN_TOKEN required' : 'ADMIN_TOKEN mismatch',
  })
}

/**
 * Parse a JSON request body that may arrive as an object (Vercel) or a string.
 * @param {import('node:http').IncomingMessage} request
 * @returns {object|undefined} the parsed body, or undefined when unusable.
 */
export function jsonBody(request) {
  const body = request.body
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string' || body.length === 0) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}
