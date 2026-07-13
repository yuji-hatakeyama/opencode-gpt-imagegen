import { MAX_EDIT_IMAGES } from "./codex"

// Bounds the store: session.deleted fires only on explicit deletion, so abandoned
// sessions would otherwise retain their data URLs for the process lifetime. A
// medium-quality PNG is ~3MB (~4MB as base64), so 8 sessions x 5 images is roughly
// 160MB steady-state; high-quality images can multiply that severalfold.
const MAX_TRACKED_SESSIONS = 8

export type SessionImageStore = {
  getRecent(sessionID: string): string[]
  record(sessionID: string, dataUrl: string): void
  evict(sessionID: string): void
}

// Tracks the data URLs of images generated per session, newest last — the pool that
// `num_last_images_to_include` draws from. Codex reads the same data back from its
// conversation history; the OpenCode plugin API exposes no history, so the plugin
// keeps its own record.
// maxSessions is injectable only so tests can reach the eviction behavior cheaply.
export function createSessionImageStore(maxSessions = MAX_TRACKED_SESSIONS): SessionImageStore {
  const imagesBySession = new Map<string, string[]>()
  return {
    getRecent(sessionID) {
      // Copied so a caller mutating the result cannot corrupt the stored history.
      return [...(imagesBySession.get(sessionID) ?? [])]
    },
    record(sessionID, dataUrl) {
      const current = imagesBySession.get(sessionID) ?? []
      // delete+set moves the session to the back of the Map's insertion order, so the
      // eviction below always removes the least-recently-recording session.
      imagesBySession.delete(sessionID)
      imagesBySession.set(sessionID, [...current, dataUrl].slice(-MAX_EDIT_IMAGES))
      if (imagesBySession.size > maxSessions) {
        const oldest = imagesBySession.keys().next().value
        if (oldest !== undefined) imagesBySession.delete(oldest)
      }
    },
    evict(sessionID) {
      imagesBySession.delete(sessionID)
    },
  }
}
