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
import { join } from 'node:path'
import handler from './api/webhook.js'
import chatHandler from './api/chat.js'
import statusHandler from './api/status.js'
import filesHandler from './api/files.js'

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

/** Minimal Vercel-like response shim: status(), json(), end(). */
function wrapResponse(response) {
  return {
    setHeader: (name, value) => response.setHeader(name, value),
    status(code) {
      response.statusCode = code
      return this
    },
    json(body) {
      // Vercel's helper serializes UTF-8; write the bytes explicitly so
      // Cyrillic survives instead of being emitted as latin1.
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Content-Length', payload.length)
      response.end(payload)
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

// Either surface may be under test: the Telegram webhook needs the webhook
// secret, while the browser console needs ADMIN_TOKEN. Requiring both would
// block a developer who is working on one of them.
const hasWebhook = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)
const hasConsole = Boolean(process.env.ADMIN_TOKEN)
if (!hasWebhook && !hasConsole) {
  console.error(
    'Set TELEGRAM_WEBHOOK_SECRET (for the bot) or ADMIN_TOKEN (for the web console) in .env.',
  )
  process.exit(1)
}

/** Route table: path prefix -> handler, mirroring the api/ directory. */
const ROUTES = [
  { match: (path) => path.startsWith('/api/webhook'), handler },
  { match: (path) => path === '/api/chat', handler: chatHandler },
  { match: (path) => path === '/api/status', handler: statusHandler },
  { match: (path) => path === '/api/files', handler: filesHandler },
]

/**
 * Serve public/index.html for `/` and any non-API path.
 *
 * Vercel's rewrite in vercel.json does this in production; the dev server
 * mirrors it so the page is reachable at the same address locally.
 */
async function servePage(response) {
  const file = join(process.cwd(), 'public', 'index.html')
  if (!existsSync(file)) {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.end('public/index.html is missing')
    return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  const html = await readFile(file, 'utf8')
  const payload = Buffer.from(html, 'utf8')
  response.setHeader('Content-Length', payload.length)
  response.end(payload)
}

createServer(async (request, response) => {
  const started = Date.now()
  request.body = await readBody(request)
  const path = String(request.url ?? '/').split('?')[0]
  const wrapped = wrapResponse(response)
  response.on('finish', () => {
    console.log(`${request.method} ${path} -> ${response.statusCode} (${Date.now() - started} ms)`)
  })
  try {
    const route = ROUTES.find((candidate) => candidate.match(path))
    if (route) {
      await route.handler(request, wrapped)
    } else {
      await servePage(response)
    }
  } catch (error) {
    console.error('unhandled:', error)
    if (!response.writableEnded) {
      response.statusCode = 500
      response.end(JSON.stringify({ ok: false }))
    }
  }
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}`)
  console.log(`  console:  http://localhost:${PORT}/`)
  console.log(`  webhook:  /api/webhook/${process.env.TELEGRAM_WEBHOOK_SECRET ?? '<secret>'}`)
  console.log(`  admin:    /api/status, /api/chat (x-admin-token: ${process.env.ADMIN_TOKEN ? 'set' : 'NOT SET'})`)
})
