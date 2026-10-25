/**
 * POST /api/chat — one browser chat turn, with repository tools.
 *
 * The model may ask for file operations; this endpoint runs them against the
 * configured GitHub folder and feeds the results back, repeating until the model
 * answers in text or the step budget runs out. Every step is reported to the
 * page so the human sees what changed.
 *
 * Auth: `x-admin-token` header must equal ADMIN_TOKEN.
 * Body: { sessionId: string, message: string, systemPrompt?: string, reset?: boolean }
 *
 * @module api/chat
 */

import { chatRaw, appendExchange, DEFAULT_MODEL } from '../lib/llm.js'
import { getHistory, setHistory, clearHistory } from '../lib/memory.js'
import { presentedToken, tokenMatches, deny, jsonBody } from '../lib/http.js'
import { countChat, countFailure } from '../lib/stats.js'
import { toolDefinitions, runTool, toolsSystemPrompt } from '../lib/tools.js'

/** Plain persona used when the deployment has no repository configured. */
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer concisely in the language the user ' +
  'writes in. The interface renders plain text with basic markdown.'

/** Longest message accepted from the browser. */
const MAX_MESSAGE_CHARS = 8000

/** Model round-trips allowed in one turn; each may call tools. */
const MAX_STEPS = 4

/** Tool-call detail returned to the page for display. */
const MAX_REPORTED_ARGS = 200

/**
 * Whether repository tools are usable in this deployment.
 * @returns {boolean} true when a token, owner and repo are all configured.
 */
function toolsEnabled() {
  return Boolean(
    process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO,
  )
}

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
  const customPrompt =
    typeof body?.systemPrompt === 'string' && body.systemPrompt.trim().length > 0
      ? body.systemPrompt.trim().slice(0, 4000)
      : ''

  if (sessionId.length === 0) return response.status(400).json({ ok: false, error: 'sessionId required' })
  if (message.length === 0) return response.status(400).json({ ok: false, error: 'message required' })
  if (message.length > MAX_MESSAGE_CHARS) {
    return response.status(413).json({ ok: false, error: `message longer than ${MAX_MESSAGE_CHARS} chars` })
  }

  const key = `browser:${sessionId}`
  if (body?.reset === true) {
    clearHistory(key)
    return response.status(200).json({ ok: true, reset: true })
  }

  const withTools = toolsEnabled()
  const systemPrompt =
    customPrompt.length > 0
      ? customPrompt
      : withTools
        ? toolsSystemPrompt()
        : (process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT)

  const history = getHistory(key)
  const conversation = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ]
  const tools = withTools ? toolDefinitions() : undefined
  const actions = []

  try {
    let finalText = ''
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const { message: assistant } = await chatRaw({
        apiKey: process.env.ROUTEWAY_API_KEY,
        model: process.env.LLM_MODEL,
        baseUrl: process.env.LLM_BASE_URL,
        messages: conversation,
        tools,
      })

      const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
      if (calls.length === 0) {
        finalText = typeof assistant.content === 'string' ? assistant.content.trim() : ''
        if (finalText.length > 0) conversation.push({ role: 'assistant', content: finalText })
        break
      }

      // The assistant turn carrying tool_calls must be echoed back verbatim,
      // otherwise the provider rejects the following tool messages.
      conversation.push({
        role: 'assistant',
        content: assistant.content ?? '',
        tool_calls: calls,
      })

      for (const call of calls) {
        const name = call?.function?.name ?? ''
        const rawArgs = call?.function?.arguments ?? '{}'
        let args
        try {
          args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
        } catch {
          args = undefined
        }
        const result = args === undefined
          ? { ok: false, error: 'arguments were not valid JSON' }
          : await runTool({ name, args })

        conversation.push({
          role: 'tool',
          tool_call_id: call?.id ?? '',
          content: JSON.stringify(result),
        })
        actions.push({
          tool: name,
          args: clip(JSON.stringify(args ?? {}), MAX_REPORTED_ARGS),
          ok: result?.ok === true,
          detail: result?.ok === true ? describeSuccess(name, result) : String(result?.error ?? ''),
        })
      }
    }

    if (finalText.length === 0) {
      finalText = actions.length > 0
        ? 'Готово. Файлы обновлены — подробности в списке действий ниже.'
        : 'Модель ничего не ответила. Попробуй переформулировать запрос.'
    }

    setHistory(key, trimForHistory(history, message, finalText, actions))
    countChat()
    return response.status(200).json({
      ok: true,
      reply: finalText,
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      toolUsed: tools !== undefined,
      actions,
      historyLength: getHistory(key).length,
    })
  } catch (error) {
    const text = String(error?.message ?? error)
    countFailure(text)
    return response.status(200).json({ ok: false, error: describeFailure(text), actions })
  }
}

/**
 * Reduce one turn to a plain-text exchange for the stored history.
 *
 * Tool calls are summarized into the assistant text instead of being kept as
 * separate history entries: the stored history feeds the next request, and a
 * dangling `tool` message without its `tool_calls` partner is a protocol error.
 *
 * @param {Array} history - previous messages.
 * @param {string} userText - the user's message.
 * @param {string} assistantText - the final answer.
 * @param {Array<object>} actions - tool calls that ran.
 * @returns {Array} the bounded history.
 */
function trimForHistory(history, userText, assistantText, actions) {
  const summary = actions.length === 0
    ? ''
    : `\n\n[выполнено: ${actions.map((a) => `${a.tool}${a.ok ? '' : ' (ошибка)'}`).join(', ')}]`
  return appendExchange(history, userText, assistantText + summary)
}

/** One-line description of what a successful tool call did. */
function describeSuccess(name, result) {
  if (name === 'repo_list') return `${(result.files ?? []).length} файлов`
  if (name === 'repo_read') return `${result.bytes ?? 0} байт`
  if (name === 'repo_write') return (result.created ? 'создан ' : 'обновлён ') + (result.path ?? '')
  if (name === 'repo_delete') return result.deleted ? 'удалён ' + result.path : 'файла не было'
  return 'ok'
}

/** Map a provider error onto a sentence a human can act on. */
function describeFailure(message) {
  if (/401|403/.test(message)) return 'ROUTEWAY_API_KEY неверный или истёк'
  if (/429/.test(message)) return 'исчерпан дневной лимит (200 запросов), попробуй позже'
  if (/402/.test(message)) return 'модель платная — нужна модель с суффиксом :free'
  if (/empty reply/i.test(message)) return 'модель вернула пустой ответ, повтори'
  if (/timeout|abort/i.test(message)) return 'модель не ответила вовремя'
  return message.slice(0, 300)
}

/** Truncate for display. */
function clip(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}
