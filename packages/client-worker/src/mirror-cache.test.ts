import { defaultLimits } from "@ace/client";
import { expect, test } from "vitest";
import { MirrorThread } from "./mirror.ts";
import { MirrorCache, mirrorCacheEntries } from "./mirror-cache.ts";

/** Fills the cache to its entry bound, oldest first. */
function full() {
  const cache = new MirrorCache();
  for (let n = 0; n < mirrorCacheEntries; n++)
    cache.set(`thread:${n}`, new MirrorThread(defaultLimits.listeners));
  return cache;
}

test("peeking at a released thread leaves it next to go, where asking for it keeps it", () => {
  const peeked = full();
  expect(peeked.peek("thread:0")).toBeDefined();
  peeked.set("thread:new", new MirrorThread(defaultLimits.listeners));
  expect(peeked.peek("thread:0")).toBeUndefined();

  const asked = full();
  expect(asked.get("thread:0")).toBeDefined();
  asked.set("thread:new", new MirrorThread(defaultLimits.listeners));
  expect(asked.peek("thread:0")).toBeDefined();
  expect(asked.peek("thread:1")).toBeUndefined();
});
