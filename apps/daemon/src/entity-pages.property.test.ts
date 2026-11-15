import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interaction, InteractionId, type ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

// Generated threads of pending and resolved requests, small, large and larger than a page, more
// than 200 pending among them, read page by page while requests are answered and new ones
// arrive between reads. Reading every page lists each request that was there when the read
// began, misses none still pending at the end, and keeps every page within its bound.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A seeded generator, so a failing case can be run again. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return { next, int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)) };
}

function thread() {
  const home = mkdtempSync(join(tmpdir(), "ace-entity-pages-"));
  const store = new Store(join(home, "events.sqlite"), console.error);
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { store, threadId: createDevThread(store, store.createWorkspace("/repo", "Repo", 1)).id };
}

const kib = 1024;

/** A request size: mostly small, some large, now and then larger than any page. */
function size(r: ReturnType<typeof random>) {
  const roll = r.next();
  if (roll < 0.6) return r.int(10, 400);
  if (roll < 0.9) return r.int(4 * kib, 60 * kib);
  if (roll < 0.97) return r.int(60 * kib, 130 * kib);
  return r.int(130 * kib, 300 * kib);
}

function requests(store: Store, threadId: ThreadId) {
  let made = 0;
  const open = (bytes: number) => {
    const id = `ask-${made++}`;
    store.appendEvents(threadId, [
      {
        type: "interaction.opened",
        interaction: Interaction.parse({
          id,
          threadId,
          agentId: "root",
          blocking: true,
          request: {
            kind: "approval",
            title: `Run ${id}`,
            description: "d".repeat(bytes),
            target: { tool: "Bash", command: `make ${id}`, access: "execute" },
            options: [{ id: `${id}:allow`, label: "Allow once", kind: "allow_once" }],
          },
          state: "pending",
          createdAt: 1,
        }),
      },
    ]);
    return id;
  };
  const resolve = (id: string) =>
    store.appendEvents(threadId, [
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse(id),
        state: "resolved",
        resolution: { kind: "approval", optionId: `${id}:allow` },
        closedAt: 2,
      },
    ]);
  return { open, resolve };
}

const cases = Array.from({ length: 24 }, (_, seed) => seed + 1);

it.each(cases)(
  "generated thread %i: every request listed, none pending missed, each page within its bound",
  (seed) => {
    const r = random(seed);
    const { store, threadId } = thread();
    const { open, resolve } = requests(store, threadId);
    const state = new Map<string, "pending" | "resolved">();
    // Some threads hold more pending requests than a page's 200 entries.
    const many = seed % 4 === 0;
    const count = many ? r.int(201, 260) : r.int(0, 60);
    for (let index = 0; index < count; index++) {
      const id = open(many ? r.int(10, 200) : size(r));
      state.set(id, "pending");
      if (r.next() < (many ? 0.1 : 0.5)) {
        resolve(id);
        state.set(id, "resolved");
      }
    }
    const atStart = new Map(state);
    const changed = new Set<string>();
    const limit = r.int(1, 200);
    const maxBytes = r.int(16 * kib, 128 * kib);
    const listed = new Map<string, number>();
    let before: number | null = Number.MAX_SAFE_INTEGER;
    for (let read = 0; before !== null; read++) {
      if (read > 2000) throw new Error("Paging did not end");
      const page = store.readEntityPage(threadId, "interactions", before, limit, maxBytes);
      if (page.collection !== "interactions") throw new Error("shape");
      expect(page.entries.length).toBeLessThanOrEqual(limit);
      const bytes = page.entries.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
        0,
      );
      expect(bytes).toBeLessThanOrEqual(maxBytes);
      for (const entry of page.entries) listed.set(entry.id, (listed.get(entry.id) ?? 0) + 1);
      if (page.entitiesBefore !== null) expect(page.entitiesBefore).toBeLessThan(before);
      before = page.entitiesBefore;
      // Between reads: some pending ones answered, new ones asked.
      for (const [id, now] of state)
        if (now === "pending" && r.next() < 0.03) {
          resolve(id);
          state.set(id, "resolved");
          changed.add(id);
        }
      if (r.next() < 0.3) state.set(open(size(r)), "pending");
    }
    for (const [id, then] of atStart) {
      // Once, unless answered during the read: then once as pending and maybe again as resolved.
      if (changed.has(id)) expect(listed.get(id) ?? 0).toBeGreaterThanOrEqual(1);
      else expect([id, listed.get(id)]).toEqual([id, 1]);
      expect(listed.get(id) ?? 0).toBeLessThanOrEqual(2);
      if (then === "pending" && state.get(id) === "pending") expect(listed.has(id)).toBe(true);
    }
    for (const times of listed.values()) expect(times).toBeLessThanOrEqual(2);
  },
);
