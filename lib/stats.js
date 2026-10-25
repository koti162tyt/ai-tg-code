/**
 * Usage counters for the admin panel.
 *
 * Serverless instances are ephemeral and not shared, so these numbers describe
 * one warm instance, not the whole deployment. The panel says so instead of
 * implying a global total. A durable counter would need Vercel KV; the same
 * note applies to conversation history.
 *
 * @module lib/stats
 */

/** When this instance started, in epoch milliseconds. */
const startedAt = Date.now()

/** Counters for this instance. */
const counters = {
  /** Requests that reached the model and succeeded. */
  chats: 0,
  /** Model failures, by short reason. */
  failures: 0,
  /** Rate-limit refusals seen from the provider. */
  quotaHits: 0,
  /** Telegram replies delivered. */
  telegramReplies: 0,
  /** Webhook updates refused by the secret check. */
  rejectedWebhooks: 0,
}

/** Record one successful model reply. */
export function countChat() {
  counters.chats += 1
}

/** Record one model failure, and whether it looked like a quota refusal. */
export function countFailure(message) {
  counters.failures += 1
  if (/429/.test(String(message))) counters.quotaHits += 1
}

/** Record one delivered Telegram message. */
export function countTelegramReply(n = 1) {
  counters.telegramReplies += n
}

/** Record one webhook refused for a bad secret. */
export function countRejectedWebhook() {
  counters.rejectedWebhooks += 1
}

/**
 * Snapshot the counters plus environment facts the panel displays.
 *
 * Secrets are reported as booleans only: the panel must never echo a token.
 *
 * @returns {object} a JSON-safe status object.
 */
export function snapshot() {
  return {
    instanceStartedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    counters: { ...counters },
    model: process.env.LLM_MODEL ?? 'gemma-4-26b-a4b-it-chimerax:free',
    configuration: {
      routewayKey: Boolean(process.env.ROUTEWAY_API_KEY),
      telegramToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      adminToken: Boolean(process.env.ADMIN_TOKEN),
    },
    node: process.version,
    region: process.env.VERCEL_REGION ?? 'unknown',
  }
}
