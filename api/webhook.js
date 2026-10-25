/**
 * Telegram webhook endpoint — the whole bot.
 *
 * Vercel turns every file under api/ into a serverless function, so this module
 * is the entire HTTP surface. Telegram POSTs an Update here; we answer the model
 * and reply. The path carries TELEGRAM_WEBHOOK_SECRET, which is how we refuse
 * updates from anyone who merely learned the deployment domain.
 *
 * Route: POST /api/webhook/<TELEGRAM_WEBHOOK_SECRET>
 *
 * @module api/webhook
 */

import { chat, appendExchange, DEFAULT_MODEL } from '../lib/modelscope.js'
import { sendMessage, sendChatAction, CHAT_ACTION_TTL } from '../lib/telegram.js'
import { getHistory, setHistory, clearHistory, historyCount } from '../lib/memory.js'

/** Message shown when the model call fails, with the reason appended. */
const FAILURE_PREFIX = 'Не смог получить ответ от модели'

/** The default persona handed to the model. Overridable per deployment. */
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant in a Telegram chat. Answer concisely and in the ' +
  'language the user writes in. Telegram shows plain text, so prefer short ' +
  'paragraphs over wide tables.'

/**
 * Handle one HTTP request.
 *
 * Telegram expects a 200 within a few seconds and retries otherwise, so every
 * branch answers quickly; the model call happens before responding but its
 * failures are reported to the user instead of surfacing as a 500 (a 500 would
 * make Telegram re-deliver the same update).
 *
 * @param {import('node:http').IncomingMessage} request - Node request.
 * @param {import('node:http').ServerResponse} response - Node response.
 */
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(200).json({ ok: true, note: 'webhook endpoint; POST only' })
  }

  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  const received = secretFromUrl(request.url)
  if (!expected) {
    // Fail closed: an unset secret would make the endpoint world-writable.
    return response.status(500).json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is not set' })
  }
  if (received !== expected) {
    return response.status(404).json({ ok: false })
  }

  const update = typeof request.body === 'string' ? safeParse(request.body) : request.body
  if (!update || typeof update !== 'object') {
    return response.status(200).json({ ok: true, ignored: 'not-json' })
  }

  // Only private-chat messages carry an answerable request here. Edits, joins,
  // channel posts and callback queries fall through to the single response
  // below with nothing to do.
  const message = update.message
  const chatId = message?.chat?.id
  const text = typeof message?.text === 'string' ? message.text.trim() : ''

  if (chatId === undefined || text.length === 0) {
    return response.status(200).json({ ok: true, ignored: 'unsupported-update' })
  }

  try {
    const handled = await handleText({ chatId, text, message })
    return response.status(200).json({ ok: true, ...handled })
  } catch (error) {
    // Surface the reason in the log without leaking the token.
    console.error('webhook failure:', redact(error?.message ?? String(error)))
    try {
      await sendMessage({
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId,
        text: `${FAILURE_PREFIX}: ${describe(error)}`,
      })
    } catch (nested) {
      console.error('could not report failure:', redact(nested?.message ?? String(nested)))
    }
    // Still 200: a non-200 makes Telegram redeliver the same update.
    return response.status(200).json({ ok: true, reported: 'failure' })
  }
}

/**
 * Answer one text message.
 *
 * @param {object} input
 * @param {number|string} input.chatId - destination chat.
 * @param {string} input.text - the user's text.
 * @param {object} input.message - the raw Telegram message, for /start name.
 * @returns {Promise<object>} a short outcome note for the HTTP body.
 */
async function handleText({ chatId, text, message }) {
  const token = process.env.TELEGRAM_BOT_TOKEN

  const command = parseCommand(text)
  if (command === 'start') {
    await sendMessage({
      token,
      chatId,
      text:
        `Привет, ${escapeName(message.from?.first_name)}!\n\n` +
        'Пиши вопрос — отвечу. Модель: ' +
        `${process.env.MODELSCOPE_MODEL ?? DEFAULT_MODEL}.\n\n` +
        'Команды: /reset — забыть разговор, /status — состояние бота.',
    })
    return { handled: 'start' }
  }
  if (command === 'reset') {
    clearHistory(chatId)
    await sendMessage({ token, chatId, text: 'Разговор забыт. Начинаем с чистого листа.' })
    return { handled: 'reset' }
  }
  if (command === 'status') {
    const history = getHistory(chatId)
    await sendMessage({
      token,
      chatId,
      text:
        `Модель: ${process.env.MODELSCOPE_MODEL ?? DEFAULT_MODEL}\n` +
        `Сообщений в этом разговоре: ${history.length}\n` +
        `Чатов в памяти: ${historyCount()}`,
    })
    return { handled: 'status' }
  }

  // Keep "typing…" visible across the model call; the action expires after
  // CHAT_ACTION_TTL seconds, so this covers a normal reply without polling.
  await sendChatAction({ token, chatId })
  setTimeout(() => {
    void sendChatAction({ token, chatId })
  }, CHAT_ACTION_TTL * 1000 * 0.8)

  const history = getHistory(chatId)
  const systemPrompt = process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT
  const reply = await chat({
    apiKey: process.env.MODELSCOPE_API_KEY,
    model: process.env.MODELSCOPE_MODEL,
    baseUrl: process.env.MODELSCOPE_BASE_URL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: text },
    ],
  })

  setHistory(chatId, appendExchange(history, text, reply))
  await sendMessage({ token, chatId, text: reply })
  return { handled: 'reply', chars: reply.length }
}

/**
 * Read the bot command from a message, without the /command@BotName suffix.
 * @param {string} text - the message text.
 * @returns {string|undefined} lowercased command name, or undefined for prose.
 */
function parseCommand(text) {
  if (!text.startsWith('/')) return undefined
  const name = text.slice(1).split(/\s+/)[0].split('@')[0].toLowerCase()
  return name || undefined
}

/**
 * Extract the secret segment from /api/webhook/<secret>.
 * @param {string|undefined} url - the request URL.
 * @returns {string|undefined} the segment, or undefined when absent.
 */
function secretFromUrl(url) {
  if (typeof url !== 'string') return undefined
  const path = url.split('?')[0]
  const match = path.match(/\/api\/webhook\/([^/]+)\/?$/)
  return match?.[1]
}

/** JSON.parse that never throws. */
function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Short, user-safe description of a failure. */
function describe(error) {
  const message = redact(error?.message ?? String(error))
  if (/401|403/.test(message)) return 'ключ ModelScope неверный или истёк'
  if (/429/.test(message)) return 'исчерпан лимит ModelScope, попробуй позже'
  if (/timeout|abort/i.test(message)) return 'модель не ответила вовремя'
  return message.slice(0, 300)
}

/** Strip anything token-shaped from a string before it reaches a log or a chat. */
function redact(text) {
  return String(text)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
}

/** Escape a first name for plain-text Telegram output. */
function escapeName(name) {
  return typeof name === 'string' && name.length > 0 ? name : 'друг'
}
