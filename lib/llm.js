/**
 * LLM client: OpenAI-compatible chat completions against Routeway.
 *
 * Routeway exposes the OpenAI wire protocol at /v1, so this is a plain fetch
 * with a bearer key. No SDK dependency: the whole surface used here is one POST,
 * and a dependency would only add install weight to a serverless deploy.
 *
 * Its free models carry a ":free" suffix and are limited to 5 requests/minute
 * and 200 requests/day per account. A 429 is therefore a normal outcome, not a
 * bug, and it is reported to the user as a quota message.
 *
 * @module lib/llm
 */

/**
 * Default model. Gemma 4 26B was the most reliable free tool-caller and the
 * cleanest writer in testing; the deepseek and minimax ":free" entries looped
 * on repetition, so they are not defaults here.
 */
export const DEFAULT_MODEL = 'gemma-4-26b-a4b-it-chimerax:free'

/** Base URL; the OpenAI-compatible prefix lives under /v1. */
const DEFAULT_BASE_URL = 'https://api.routeway.ai/v1'

/** History kept per chat, in messages (user+assistant pairs). */
export const MAX_HISTORY_MESSAGES = 16

/** Maximum tokens the model may produce in one reply. */
const MAX_OUTPUT_TOKENS = 1024

/** Hard cap on the characters a single user message may contribute. */
const MAX_USER_CHARS = 6000

/**
 * Ask the model for one reply.
 *
 * @param {object} options
 * @param {string} options.apiKey - Routeway API key.
 * @param {Array<{role: string, content: string}>} options.messages - the full
 *   conversation, oldest first; the last entry is the user's new message.
 * @param {string} [options.model] - model id; defaults to DEFAULT_MODEL.
 * @param {string} [options.baseUrl] - override for the API root.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<string>} the assistant's text, trimmed and non-empty.
 */
export async function chat({ apiKey, messages, model, baseUrl, signal }) {
  if (!apiKey) throw new Error('ROUTEWAY_API_KEY is not set')
  const url = `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`

  const body = {
    model: model ?? DEFAULT_MODEL,
    messages,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.7,
    stream: false,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  const raw = await response.text()
  if (!response.ok) {
    // Surface the provider's own diagnostic: a quota error and a bad key need
    // different actions from the human, and a generic message hides which it is.
    throw new Error(`Routeway ${response.status}: ${raw.slice(0, 400)}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Routeway returned non-JSON: ${raw.slice(0, 200)}`)
  }

  const text = parsed?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Routeway returned an empty reply')
  }
  return text.trim()
}

/**
 * Append one exchange to a conversation and keep it bounded.
 *
 * Old messages are dropped from the front, which keeps the most recent context
 * and bounds the prompt size the free tier is charged for.
 *
 * @param {Array<{role: string, content: string}>} history - existing messages.
 * @param {string} userText - the new user message.
 * @param {string} assistantText - the model's reply.
 * @returns {Array<{role: string, content: string}>} the trimmed conversation.
 */
export function appendExchange(history, userText, assistantText) {
  const next = [
    ...history,
    { role: 'user', content: clip(userText, MAX_USER_CHARS) },
    { role: 'assistant', content: assistantText },
  ]
  return next.length > MAX_HISTORY_MESSAGES
    ? next.slice(next.length - MAX_HISTORY_MESSAGES)
    : next
}

/** Truncate a string to `limit` characters with a visible marker. */
function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`
}
