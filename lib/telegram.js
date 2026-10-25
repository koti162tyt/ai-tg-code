/**
 * Telegram Bot API client, restricted to the calls this bot makes.
 *
 * All calls are one-shot fetches: a Vercel function is not allowed to keep a
 * process alive between requests, so there is no polling loop and no socket.
 * The bot is driven entirely by the webhook.
 *
 * @module lib/telegram
 */

const API_ROOT = 'https://api.telegram.org'

/** Telegram's own limit for one message; longer replies are split. */
const MAX_MESSAGE_CHARS = 4096

/** Keep a margin under the limit for the "(1/3)" prefix on split parts. */
const SPLIT_AT = 3800

/** Seconds Telegram shows "typing…" for; refreshed by chat-action calls. */
export const CHAT_ACTION_TTL = 5

/**
 * Call one Bot API method.
 *
 * @param {object} options
 * @param {string} options.token - bot token from @BotFather.
 * @param {string} options.method - Bot API method name, e.g. "sendMessage".
 * @param {object} [options.payload] - JSON body.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<object>} the `result` member of a successful reply.
 */
export async function call({ token, method, payload, signal }) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
  const response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  })
  const raw = await response.text()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Telegram ${method}: non-JSON reply: ${raw.slice(0, 200)}`)
  }
  if (!parsed.ok) {
    throw new Error(
      `Telegram ${method} failed: ${parsed.error_code ?? '?'} ${parsed.description ?? ''}`,
    )
  }
  return parsed.result
}

/**
 * Send text, splitting anything over Telegram's per-message limit.
 *
 * A split reply is numbered so the reader knows more is coming. Parts are sent
 * in order and awaited, because Telegram preserves order per chat but parallel
 * sends can interleave.
 *
 * @param {object} options - token, chatId, text, plus optional signal.
 */
export async function sendMessage({ token, chatId, text, signal }) {
  const parts = splitText(text)
  const results = []
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.length > 1 ? `(${index + 1}/${parts.length}) ` : ''
    results.push(
      await call({
        token,
        method: 'sendMessage',
        payload: {
          chat_id: chatId,
          text: prefix + parts[index],
          disable_web_page_preview: true,
        },
        signal,
      }),
    )
  }
  return results
}

/**
 * Show a chat action ("typing…") in a chat.
 *
 * Best effort: a failure here must never abort a reply that is already composed.
 */
export async function sendChatAction({ token, chatId, action = 'typing', signal }) {
  try {
    await call({ token, method: 'sendChatAction', payload: { chat_id: chatId, action }, signal })
  } catch {
    // Ignored on purpose: cosmetic only.
  }
}

/**
 * Split text into Telegram-sized parts, preferring line breaks.
 *
 * @param {string} text - the reply to split.
 * @returns {string[]} one or more non-empty parts.
 */
export function splitText(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return [text]
  const parts = []
  let rest = text
  while (rest.length > SPLIT_AT) {
    // Prefer a paragraph break, then a line break, then a space near the limit;
    // a hard cut is the last resort so no character is ever lost.
    const window = rest.slice(0, SPLIT_AT)
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ')]
    const cut = candidates.find((index) => index > SPLIT_AT * 0.5) ?? -1
    const at = cut > 0 ? cut + 1 : SPLIT_AT
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trimStart()
  }
  if (rest.length > 0) parts.push(rest)
  return parts.filter((part) => part.length > 0)
}
