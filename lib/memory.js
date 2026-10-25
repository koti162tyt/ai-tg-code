/**
 * Chat history, kept in memory of one warm function instance.
 *
 * This is deliberately not durable. On a serverless platform a cold start loses
 * it, and two concurrent instances do not share it. That is acceptable for a
 * demo bot whose replies are stateless-friendly, and it avoids adding a database
 * to a free deployment. If durable history is needed later, replace this module
 * with a Vercel KV / Redis implementation behind the same four functions.
 *
 * Bounded twice: by MAX_CHATS (oldest chat evicted) and per chat by the history
 * trim inside lib/modelscope.js.
 *
 * @module lib/memory
 */

/** Maximum conversations held at once. */
const MAX_CHATS = 200

/** chatId -> messages, in insertion order for cheap eviction. */
const chats = new Map()

/** Read one conversation, or an empty list. */
export function getHistory(chatId) {
  return chats.get(String(chatId)) ?? []
}

/** Replace one conversation, evicting the oldest chat when over capacity. */
export function setHistory(chatId, messages) {
  const key = String(chatId)
  chats.delete(key)
  chats.set(key, messages)
  while (chats.size > MAX_CHATS) {
    const oldest = chats.keys().next().value
    chats.delete(oldest)
  }
}

/** Forget one conversation (the /reset command). */
export function clearHistory(chatId) {
  chats.delete(String(chatId))
}

/** Number of conversations currently held; used by /status. */
export function historyCount() {
  return chats.size
}
