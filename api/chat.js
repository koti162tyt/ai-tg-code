/**
 * POST /api/chat — one browser chat turn.
 *
 * The browser page talks to this endpoint instead of Telegram. It shares the
 * same model client, the same history module and the same failure vocabulary as
 * the webhook, so a bug fixed here is fixed for both surfaces.
 *
 * Auth: `x-admin-token` header must equal ADMIN_TOKEN.
 * Body: { sessionId: string, message: string }
 *
 * @module api/chat
 */

import { chat, appendExchange, DEFAULT_MODEL } from '../lib/llm.js'
import { getHistory, setHistory, clearHistory } from '../lib/memory.js'
import { presentedToken, tokenMatches, deny, jsonBody } from '../lib/http.js'
import { countChat, countFailure } from '../lib/stats.js'

/** The default persona; the panel can override it per request. */
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer concisely in the language the user ' +
  'writes in. The interface renders plain text with basic markdown.'

/** Longest message accepted from the browser. */
const MAX_MESSAGE_CHARS = 8000

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ ok: false, error: 'POST only' })
  }

  const presented = presentedToken(request)
  if (!tokenMatches(presented, process.env.ADMIN_TOKEN)) return deny(response, presented)

  const body = jsonBody(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.slice(0, 80) : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  const systemPrompt =
    typeof body?.systemPrompt === 'string' && body.systemPrompt.trim().length > 0
      ? body.systemPrompt.slice(0, 4000)
      : (process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT)

  if (sessionId.length === 0) return response.status(400).json({ ok: false, error: 'sessionId required' })
  if (message.length === 0) return response.status(400).json({ ok: false, error: 'message required' })
  if (message.length > MAX_MESSAGE_CHARS) {
    return response.status(413).json({ ok: false, error: `message longer than ${MAX_MESSAGE_CHARS} chars` })
  }

  if (body?.reset === true) {
    clearHistory(`browser:${sessionId}`)
    return response.status(200).json({ ok: true, reset: true })
  }

  const key = `browser:${sessionId}`
  const history = getHistory(key)

  try {
    const reply = await chat({
      apiKey: process.env.ROUTEWAY_API_KEY,
      model: process.env.LLM_MODEL,
      baseUrl: process.env.LLM_BASE_URL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ],
    })
    setHistory(key, appendExchange(history, message, reply))
    countChat()
    return response.status(200).json({
      ok: true,
      reply,
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      historyLength: getHistory(key).length,
    })
  } catch (error) {
    const text = String(error?.message ?? error)
    countFailure(text)
    return response.status(200).json({ ok: false, error: describe(text) })
  }
}

/** Map a provider error onto a sentence a human can act on. */
function describe(message) {
  if (/401|403/.test(message)) return 'ROUTEWAY_API_KEY неверный или истёк'
  if (/429/.test(message)) return 'исчерпан дневной лимит (200 запросов), попробуй позже'
  if (/402/.test(message)) return 'модель платная — нужна модель с суффиксом :free'
  if (/empty reply/i.test(message)) return 'модель вернула пустой ответ, повтори'
  if (/timeout|abort/i.test(message)) return 'модель не ответила вовремя'
  return message.slice(0, 300)
}
