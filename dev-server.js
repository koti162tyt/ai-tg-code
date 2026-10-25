/**
 * Local development server.
 *
 * Runs the same handler Vercel runs, on a plain Node HTTP server, so a deploy is
 * not the first time the code is exercised. It loads .env from disk, parses JSON
 * bodies the way Vercel does, and prints each request so webhook setup is visible.
 *
 *   npm run dev
 *   npm run set-webhook -- https://<your-tunnel>.example.com
 *
 * @module dev-server
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import handler from './api/webhook.js'

/** Port to listen on; PORT wins so a tunnel tool can pick it. */
const PORT = Number(process.env.PORT ?? 3000)

/** Read .env into process.env without overwriting anything already set. */
async function loadEnv() {
  if (!existsSync('.env')) return
  const text = await readFile('.env', 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** Minimal Vercel-like response shim: status(), json(). */
function wrapResponse(response) {
  return {
    setHeader: (name, value) => response.setHeader(name, value),
    status(code) {
      response.statusCode = code
      return this
    },
    json(body) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
      return this
    },
  }
}

/** Read the whole request body as UTF-8. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

await loadEnv()

if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.error('TELEGRAM_WEBHOOK_SECRET is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

createServer(async (request, response) => {
  const started = Date.now()
  request.body = await readBody(request)
  const wrapped = wrapResponse(response)
  response.on('finish', () => {
    console.log(`${request.method} ${request.url} -> ${response.statusCode} (${Date.now() - started} ms)`)
  })
  try {
    await handler(request, wrapped)
  } catch (error) {
    console.error('unhandled:', error)
    if (!response.writableEnded) response.statusCode = 500
    if (!response.writableEnded) response.end(JSON.stringify({ ok: false }))
  }
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}`)
  console.log(`webhook path: /api/webhook/${process.env.TELEGRAM_WEBHOOK_SECRET}`)
})
