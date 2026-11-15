import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Interaction,
  InteractionId,
  type InteractionResolution,
  type ThreadId,
} from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { requestChars, wholeRequestChars } from "@ace/projection/interaction-summary";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

// Generated threads of pending and resolved requests (approvals with large descriptions or
// commands, large question sets, large form schemas, some larger than any page, more than 200
// pending among them) read page by page while requests are answered and new ones arrive
// between reads. Reading every page lists every request pending both when the read began and
// when it ended, and every one resolved throughout, exactly once: whole, or summarized and saying
// so when it is too large to send whole (ADR 0156). Every page holds what was asked, or one
// request larger than that alone.

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

/** A request of about `bytes`, its bulk where a generated shape puts it. */
function request(r: ReturnType<typeof random>, id: string, bytes: number): Interaction["request"] {
  const bulk = "x".repeat(bytes);
  switch (r.int(0, 3)) {
    case 0:
      return {
        kind: "approval",
        title: `Run ${id}`,
        description: bulk,
        target: { tool: "Bash", command: `make ${id}`, access: "execute" },
        options: [{ id: `${id}:allow`, label: "Allow once", kind: "allow_once" }],
      };
    case 1: {
      // A command as long as one may be (32 KiB), the rest in many labelled options.
      const command = `make ${id} ${"c".repeat(Math.min(bytes, 32_000))}`;
      const rest = Math.max(0, bytes - 32_000);
      return {
        kind: "approval",
        title: `Run ${id}`,
        target: { tool: "Bash", command, access: "execute" },
        options: [
          { id: `${id}:allow`, label: "Allow once", kind: "allow_once" },
          ...Array.from({ length: Math.ceil(rest / 4096) }, (_, index) => ({
            id: `${id}:${index}`,
            label: "o".repeat(4096),
            kind: "deny" as const,
          })),
        ],
      };
    }
    case 2: {
      const each = Math.max(1, Math.floor(bytes / 8));
      return {
        kind: "question",
        questions: Array.from({ length: 8 }, (_, index) => ({
          id: `q${index}`,
          text: `Which ${index}? ${"y".repeat(each)}`,
          options: [{ id: "a", label: "A" }],
          multiSelect: false,
          allowOther: true,
          secret: false,
        })),
      };
    }
    default:
      return {
        kind: "elicitation",
        server: "docs",
        message: `Fill ${id}`,
        schema: { type: "object", properties: { field: { type: "string", description: bulk } } },
      };
  }
}

/** An answer that fits the request's kind. */
function resolutionOf(kind: string | undefined, id: string): InteractionResolution {
  if (kind === "approval") return { kind: "approval", optionId: `${id}:allow` };
  if (kind === "question") return { kind: "question", answers: {}, dismissed: true };
  return { kind: "elicitation", action: "decline" };
}

function requests(store: Store, threadId: ThreadId, r: ReturnType<typeof random>) {
  let made = 0;
  const asked = new Map<string, Interaction["request"]>();
  const open = (bytes: number) => {
    const id = `ask-${made++}`;
    const interaction = Interaction.parse({
      id,
      threadId,
      agentId: "root",
      blocking: true,
      request: request(r, id, bytes),
      state: "pending",
      createdAt: 1,
    });
    asked.set(id, interaction.request);
    store.appendEvents(threadId, [{ type: "interaction.opened", interaction }]);
    return id;
  };
  const resolve = (id: string) =>
    store.appendEvents(threadId, [
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse(id),
        state: "resolved",
        resolution: resolutionOf(asked.get(id)?.kind, id),
        closedAt: 2,
      },
    ]);
  return { open, resolve, asked };
}

const cases = Array.from({ length: 24 }, (_, seed) => seed + 1);

it.each(cases)(
  "generated thread %i: every request pending throughout listed whole, each page within its bound",
  (seed) => {
    const r = random(seed);
    const { store, threadId } = thread();
    const { open, resolve, asked } = requests(store, threadId, r);
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
      // What was asked, or one request larger than that, alone.
      if (page.entries.length > 1) expect(bytes).toBeLessThanOrEqual(maxBytes);
      for (const entry of page.entries) {
        const whole = asked.get(entry.id);
        if (!whole) throw new Error(`Never asked ${entry.id}`);
        // Whole, exactly what was asked, or a summary that says how large the whole is.
        if (requestChars(whole) <= wholeRequestChars) expect(entry.request).toEqual(whole);
        else expect(entry.truncated).toEqual({ chars: requestChars(whole) });
        listed.set(entry.id, (listed.get(entry.id) ?? 0) + 1);
      }
      if (page.entitiesBefore !== null) expect(page.entitiesBefore).toBeLessThan(before);
      before = page.entitiesBefore;
      // Between reads: some pending ones answered, new ones asked.
      for (const [id, now] of state)
        if (now === "pending" && r.next() < 0.03) {
          resolve(id);
          state.set(id, "resolved");
        }
      if (r.next() < 0.3) state.set(open(size(r)), "pending");
    }
    for (const [id, then] of atStart) {
      const now = state.get(id);
      // Pending when the read began and when it ended: listed.
      if (then === "pending" && now === "pending") expect([id, listed.get(id)]).toEqual([id, 1]);
      // Resolved throughout: listed once.
      if (then === "resolved") expect([id, listed.get(id)]).toEqual([id, 1]);
    }
    // Never more than once in each state.
    for (const times of listed.values()) expect(times).toBeLessThanOrEqual(2);
  },
);
