import { describe, expect, test } from "bun:test"
import { createSessionImageStore } from "../../src/session-images"

describe("createSessionImageStore", () => {
  test("returns an empty list for an unknown session", () => {
    const store = createSessionImageStore()
    expect(store.getRecent("s1")).toEqual([])
  })

  test("records images newest last", () => {
    const store = createSessionImageStore()
    store.record("s1", "url-1")
    store.record("s1", "url-2")
    expect(store.getRecent("s1")).toEqual(["url-1", "url-2"])
  })

  test("keeps only the last 5 images per session", () => {
    const store = createSessionImageStore()
    for (let n = 1; n <= 6; n++) store.record("s1", `url-${n}`)
    expect(store.getRecent("s1")).toEqual(["url-2", "url-3", "url-4", "url-5", "url-6"])
  })

  test("evicts the least-recently-recording session once over the session cap", () => {
    // maxSessions is lowered to 2 so the eviction is reachable without 9 sessions.
    const store = createSessionImageStore(2)
    store.record("s1", "url-1")
    store.record("s2", "url-2")
    store.record("s3", "url-3")
    expect(store.getRecent("s1")).toEqual([])
    expect(store.getRecent("s2")).toEqual(["url-2"])
    expect(store.getRecent("s3")).toEqual(["url-3"])
  })

  test("recording refreshes a session's recency for eviction", () => {
    const store = createSessionImageStore(2)
    store.record("s1", "url-1")
    store.record("s2", "url-2")
    store.record("s1", "url-1b")
    store.record("s3", "url-3")
    expect(store.getRecent("s1")).toEqual(["url-1", "url-1b"])
    expect(store.getRecent("s2")).toEqual([])
  })

  test("evict removes a session's images", () => {
    const store = createSessionImageStore()
    store.record("s1", "url-1")
    store.evict("s1")
    expect(store.getRecent("s1")).toEqual([])
  })

  test("does nothing when evicting a session that was never recorded", () => {
    const store = createSessionImageStore()
    store.record("s1", "url-1")
    store.evict("unknown")
    expect(store.getRecent("s1")).toEqual(["url-1"])
  })
})
