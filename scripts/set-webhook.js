/**
 * Register (or remove) the Telegram webhook for this deployment.
 *
 *   node scripts/set-webhook.js https://your-app.vercel.app
 *   node scripts/set-webhook.js --delete
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env. The secret is
 * part of the URL path, which is what the handler checks.
 *
 * @module scripts/set-webhook
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** Load .env into process.env without overriding existing values. */
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

/** Call a Bot API method and print its result. */
async function call(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await response.json()
  if (!body.ok) throw new Error(`${method}: ${body.error_code} ${body.description}`)
  return body.result
}

await loadEnv()

const argument = process.argv[2]
try {
  if (argument === '--delete') {
    const result = await call('deleteWebhook', { drop_pending_updates: true })
    console.log('webhook deleted:', result)
    process.exit(0)
  }
  if (!argument || !/^https:\/\//.test(argument)) {
    console.error('Usage: node scripts/set-webhook.js https://your-app.vercel.app')
    console.error('       node scripts/set-webhook.js --delete')
    process.exit(1)
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set')
  const url = `${argument.replace(/\/$/, '')}/api/webhook/${secret}`
  await call('setWebhook', {
    url,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  })
  const info = await call('getWebhookInfo', {})
  console.log('webhook set to', url)
  console.log('pending updates:', info.pending_update_count, '| last error:', info.last_error_message ?? 'none')
} catch (error) {
  console.error('failed:', error.message)
  process.exit(1)
}
