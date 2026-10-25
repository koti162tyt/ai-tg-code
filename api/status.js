/**
 * GET /api/status — admin panel data.
 *
 * Reports this instance's counters, whether each secret is configured, and the
 * live Telegram webhook state. The webhook state comes from Telegram, so it is
 * the one number here that describes the whole bot rather than this instance.
 *
 * Auth: `x-admin-token` header must equal ADMIN_TOKEN.
 *
 * @module api/status
 */

import { snapshot } from '../lib/stats.js'
import { call } from '../lib/telegram.js'
import { presentedToken, tokenMatches, deny } from '../lib/http.js'

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export default async function handler(request, response) {
  const presented = presentedToken(request)
  if (!tokenMatches(presented, process.env.ADMIN_TOKEN)) return deny(response, presented)

  const status = snapshot()

  // The panel is useful without a configured bot, so a Telegram lookup failure
  // is reported as data rather than failing the whole request.
  status.webhook = await webhookInfo()

  return response.status(200).json({ ok: true, status })
}

/**
 * Ask Telegram for the current webhook state.
 * @returns {Promise<object>} webhook facts, or an error note.
 */
async function webhookInfo() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { configured: false, reason: 'TELEGRAM_BOT_TOKEN not set' }
  try {
    const info = await call({ token: process.env.TELEGRAM_BOT_TOKEN, method: 'getWebhookInfo' })
    return {
      configured: true,
      url: info.url || '',
      pending: info.pending_update_count ?? 0,
      lastError: info.last_error_message ?? '',
      lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : '',
    }
  } catch (error) {
    return { configured: true, error: String(error?.message ?? error).slice(0, 200) }
  }
}
