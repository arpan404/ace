import "./test-host.ts";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport, type FakeDaemonOptions } from "@ace/fake-daemon";
import { DeviceId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { NeedsAction, followNeeds } from "./inbox-needs.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const asking = ThreadId.parse("asking");
const resting = ThreadId.parse("resting");
function schedule(delay: number, run: () => void) {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}

const approval = (interaction: string, command: string) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction,
  blocking: true,
  request: {
    kind: "approval" as const,
    title: "Run a command",
    target: { tool: "Bash", command, access: "execute" as const },
    options: [
      { id: `${interaction}:deny`, label: "Deny", kind: "deny" as const },
      { id: `${interaction}:allow`, label: "Allow", kind: "allow_once" as const },
    ],
  },
});

/** The real SDK against the fixture daemon; patches are what Swift would receive. */
async function phone(
  setup: {
    entityPages?: "active-first" | "chronological";
    /** The largest request the daemon sends; larger ones it names as too large. */
    largestEntity?: number;
    /** More history on the asking thread, after its first approval, before the phone starts. */
    history?: (daemon: FakeDaemon, options: FakeDaemonOptions) => void;
  } = {},
) {
  // Read by the daemon on every page, so a test can upgrade or downgrade it mid-read.
  const options: FakeDaemonOptions = {
    clock: () => 1000,
    ...(setup.entityPages ? { entityPages: setup.entityPages } : {}),
    ...(setup.largestEntity ? { largestEntity: setup.largestEntity } : {}),
  };
  const daemon = new FakeDaemon(options);
  for (const [id, title] of [
    [asking, "Give every Fleet map wire its own path"],
    [resting, "Show each remote network in Settings"],
  ] as const)
    daemon.createThread({ id, workspaceId: "ace", title, provider: "claude", access: "ask" });
  daemon.apply(asking, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    approval("first", "bun run test:changed --with-process"),
  ]);
  daemon.apply(resting, [facts.rootAgent("claude")]);
  setup.history?.(daemon, options);
  let sequence = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: schedule },
    random: () => 0,
    id: () => `id-${++sequence}`,
  });
  const patches: Record<string, unknown>[] = [];
  const sink = {
    put: (_key: string, read: () => Record<string, unknown> | undefined) => {
      const patch = read();
      if (patch) patches.push(patch);
    },
    clear: () => {},
  };
  const list = client.threads();
  const needs = followNeeds(client, sink);
  closers.push(async () => {
    needs.stop();
    list.release();
    await client.close();
  });
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
  const latest = (threadId: string) =>
    patches.findLast((patch) => patch.type === "inbox.needs" && patch.id === threadId);
  const of = (type: string) => patches.filter((patch) => patch.type === type);
  const act = (action: unknown) => needs.handle(NeedsAction.parse(action));
  /** The daemon's copy of the first request a row showed. */
  const shown = () => (latest(asking)?.requests as { id: string }[] | undefined)?.[0]?.id ?? "";
  const interaction = (id: string) => {
    const view = daemon.snapshot({ kind: "thread", threadId: asking });
    return view?.kind === "thread" ? view.interactions[id] : undefined;
  };
  return { daemon, latest, of, act, interaction, shown };
}

it("a row that needs the person carries its pending approval and command, read without opening the thread", async () => {
  const { latest } = await phone();
  await vi.waitFor(() =>
    expect(latest(asking)).toMatchObject({
      total: 1,
      requests: [
        {
          kind: "approval",
          state: "pending",
          command: "bun run test:changed --with-process",
          options: [{ kind: "deny" }, { kind: "allow_once" }],
        },
      ],
    }),
  );
  // A thread that waits on nothing is never read.
  expect(latest(resting)).toBeUndefined();
});

it("a second request joining the thread shows as the next of two, in the order they were asked", async () => {
  const { daemon, latest } = await phone();
  await vi.waitFor(() => expect(latest(asking)).toMatchObject({ total: 1 }));
  daemon.apply(asking, [approval("second", "git push")]);
  await vi.waitFor(() => expect(latest(asking)).toMatchObject({ total: 2 }));
  const requests = latest(asking)?.requests as { command: string }[];
  expect(requests.map((request) => request.command)).toEqual([
    "bun run test:changed --with-process",
    "git push",
  ]);
});

it("Allow answers the exact offered option, and the row empties only once the daemon closes the request", async () => {
  const { latest, of, act, interaction, shown } = await phone();
  await vi.waitFor(() => expect(latest(asking)).toMatchObject({ total: 1 }));
  const id = shown();
  act({
    type: "needs.answer",
    threadId: asking,
    interactionId: id,
    answer: { kind: "approval", optionId: "first:allow" },
    requestId: "allow-1",
  });
  await vi.waitFor(() =>
    expect(of("receipt").find((patch) => patch.id === "allow-1")).toMatchObject({ ok: true }),
  );
  expect(interaction(id)).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "first:allow" },
  });
  await vi.waitFor(() => expect(latest(asking)).toMatchObject({ total: 0, requests: [] }));
});

it("an answer to a request no longer pending sends nothing and gives the controls back quietly", async () => {
  const { latest, of, act, interaction, shown } = await phone();
  await vi.waitFor(() => expect(latest(asking)).toMatchObject({ total: 1 }));
  const id = shown();
  act({
    type: "needs.answer",
    threadId: asking,
    interactionId: id,
    answer: { kind: "approval", optionId: "always-allow-everything" },
    requestId: "stale-1",
  });
  await vi.waitFor(() =>
    expect(of("admission").find((patch) => patch.id === "stale-1")).toEqual({
      type: "admission",
      id: "stale-1",
      ok: false,
      message: "",
    }),
  );
  expect(of("receipt")).toHaveLength(0);
  expect(interaction(id)?.state).toBe("pending");
});

/** `count` newer approvals of about `bytes` each on the asking thread, all already answered. */
const answered = (count: number, bytes: number) => (daemon: FakeDaemon) => {
  for (let index = 0; index < count; index++) {
    const id = `done-${index}`;
    daemon.apply(asking, [
      // An interaction keeps its provider frames: what makes real ones large.
      { ...approval(id, "make"), raw: [{ type: "tool_use", data: { input: "x".repeat(bytes) } }] },
      {
        type: "interaction.closed" as const,
        interaction: id,
        state: "resolved" as const,
        resolution: { kind: "approval" as const, optionId: `${id}:allow` },
      },
    ]);
  }
};

it.each(["chronological", "active-first"] as const)(
  "a pending approval behind many large answered ones still shows (%s daemon)",
  async (entityPages) => {
    // 16 answered approvals of about 40 KiB: more than four 128 KiB pages in front of it.
    const { latest } = await phone({ entityPages, history: answered(16, 40 * 1024) });
    await vi.waitFor(() =>
      expect(latest(asking)).toMatchObject({
        total: 1,
        requests: [{ kind: "approval", command: "bun run test:changed --with-process" }],
      }),
    );
  },
);

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

/** One request on the asking thread, about `bytes` long, its bulk where `shape` puts it. */
function ask(id: string, bytes: number, shape: number) {
  const base = approval(id, `make ${id}`);
  const bulk = "x".repeat(bytes);
  switch (shape % 4) {
    case 0:
      // Provider frames: what makes real ones large.
      return { ...base, raw: [{ type: "tool_use", data: { input: bulk } }] };
    case 1:
      // A long command (as long as one may be), the rest in many labelled options.
      return {
        ...base,
        request: {
          ...base.request,
          target: {
            ...base.request.target,
            command: `make ${id} ${"c".repeat(Math.min(bytes, 32_000))}`,
          },
          options: [
            ...base.request.options,
            ...Array.from(
              { length: Math.ceil(Math.max(0, bytes - 32_000) / 4096) },
              (_, index) => ({
                id: `${id}:${index}`,
                label: "o".repeat(4096),
                kind: "deny" as const,
              }),
            ),
          ],
        },
      };
    case 2:
      return {
        ...base,
        request: {
          kind: "question" as const,
          questions: Array.from({ length: 8 }, (_, index) => ({
            id: `${id}:q${index}`,
            text: `Which ${id}? ${"y".repeat(Math.ceil(bytes / 8))}`,
            options: [{ id: "a", label: "A" }],
            multiSelect: false,
            allowOther: true,
            secret: false,
          })),
        },
      };
    default:
      return {
        ...base,
        request: {
          kind: "elicitation" as const,
          server: "docs",
          message: `Fill ${id}`,
          schema: { type: "object", properties: { field: { type: "string", description: bulk } } },
        },
      };
  }
}
/** How a shown row names its request: an approval by its command, a question or form by its words. */
const named = (id: string, shape: number) =>
  shape % 4 === 2 ? `Which ${id}?` : shape % 4 === 3 ? `Fill ${id}` : `make ${id}`;
const rowName = (request: Record<string, unknown>) => {
  const questions = request.questions as { text: string }[] | undefined;
  return String(
    request.kind === "approval"
      ? request.command
      : (questions?.[0]?.text ?? (request.form as { message?: string } | undefined)?.message ?? ""),
  );
};
const answer = (id: string, kind = "approval") => ({
  type: "interaction.closed" as const,
  interaction: id,
  state: "resolved" as const,
  resolution:
    kind === "question"
      ? { kind: "question" as const, answers: {}, dismissed: true }
      : kind === "elicitation"
        ? { kind: "elicitation" as const, action: "decline" as const }
        : { kind: "approval" as const, optionId: `${id}:allow` },
});

it.each(
  (["active-first", "chronological"] as const).flatMap((entityPages) =>
    [1, 2, 3, 4, 5, 6].map((seed) => ({ entityPages, seed })),
  ),
)(
  "generated thread $seed: the row counts every request waiting, whatever their number and size, and shows pending ones ($entityPages daemon)",
  async ({ entityPages, seed }) => {
    const r = random(seed);
    const kib = 1024;
    const bytes = () => {
      const roll = r.next();
      return roll < 0.6
        ? r.int(10, 400)
        : roll < 0.9
          ? r.int(4 * kib, 60 * kib)
          : r.int(130 * kib, 300 * kib);
    };
    /** Each request still pending, with the shape it was asked in. */
    const pending = new Map<string, number>([["first", 0]]);
    let made = 0;
    const kinds = ["approval", "approval", "question", "elicitation"];
    const open = (daemon: FakeDaemon, size: number) => {
      const id = `ask-${made++}`;
      const shape = r.int(0, 3);
      daemon.apply(asking, [ask(id, size, shape)]);
      pending.set(id, shape);
      return id;
    };
    const close = (daemon: FakeDaemon, id: string) => {
      daemon.apply(asking, [answer(id, kinds[(pending.get(id) ?? 0) % 4])]);
      pending.delete(id);
    };
    const history = (daemon: FakeDaemon) => {
      // Some threads hold more pending requests than one page's 200 entries.
      const count = seed % 3 === 0 ? r.int(201, 230) : r.int(0, 40);
      for (let index = 0; index < count; index++) {
        const id = open(daemon, seed % 3 === 0 ? r.int(10, 200) : bytes());
        if (r.next() < 0.4) close(daemon, id);
      }
    };
    // The new daemon names requests over 200 KiB as too large to send.
    const { daemon, latest } = await phone({ entityPages, history, largestEntity: 200 * kib });
    // While the phone reads: requests answered and new ones asked.
    for (let round = 0; round < 6; round++) {
      await new Promise((wake) => setTimeout(wake, r.int(0, 5)));
      for (const id of pending.keys()) if (id !== "first" && r.next() < 0.05) close(daemon, id);
      if (r.next() < 0.5) open(daemon, bytes());
    }
    const names = () =>
      new Set(
        [...pending].map(([id, shape]) =>
          id === "first" ? "bun run test:changed --with-process" : named(id, shape),
        ),
      );
    await vi.waitFor(
      () => {
        const row = latest(asking) as
          | { total: number; requests: Record<string, unknown>[] }
          | undefined;
        expect(row?.total).toBe(pending.size);
        expect(row?.requests).toHaveLength(Math.min(8, pending.size));
        expect(new Set(row?.requests.map((request) => request.id)).size).toBe(row?.requests.length);
        // Each shown is pending: named as asked, or one too large to send.
        for (const request of row?.requests ?? [])
          if (request.kind !== "too_large")
            expect([...names()].some((name) => rowName(request).startsWith(name))).toBe(true);
      },
      { timeout: 4000 },
    );
  },
);

it("a request too large to send is counted and shown as one to open on a computer, never answered here", async () => {
  const { latest } = await phone({
    largestEntity: 64 * 1024,
    history: (fake) => fake.apply(asking, [ask("huge", 100 * 1024, 0)]),
  });
  await vi.waitFor(() =>
    expect(latest(asking)).toMatchObject({
      total: 2,
      requests: [
        { kind: "approval", command: "bun run test:changed --with-process" },
        { kind: "too_large", title: "A request too large to show here", options: [] },
      ],
    }),
  );
});

/** Run `after` on the daemon after each interactions page it answers, from before the phone starts. */
const onPages = (daemon: FakeDaemon, after: (pages: number) => void) => {
  const read = daemon.entities.bind(daemon);
  let pages = 0;
  daemon.entities = (...args) => {
    const page = read(...args);
    if (args[1] === "interactions") after(++pages);
    return page;
  };
};

it("a request opened while the phone reads is shown by the read its count change starts", async () => {
  let reads = 0;
  const { latest } = await phone({
    history: (daemon) => {
      answered(16, 40 * 1024)(daemon);
      // The new request arrives after the phone's first page, while its read is under way.
      onPages(daemon, (pages) => {
        reads = pages;
        if (pages === 1) daemon.apply(asking, [approval("late", "git push")]);
      });
    },
  });
  await vi.waitFor(() => {
    const row = latest(asking) as { total: number; requests: { command: string }[] } | undefined;
    expect(row?.total).toBe(2);
    expect(row?.requests.map((request) => request.command).toSorted()).toEqual([
      "bun run test:changed --with-process",
      "git push",
    ]);
  });
  // The page it was opened behind, then the read again its count change started.
  expect(reads).toBeGreaterThan(1);
});

it.each([
  ["upgraded", "chronological", "active-first"],
  ["downgraded", "active-first", "chronological"],
] as const)(
  "a daemon %s between the phone's pages: every pending request shown once",
  async (_label, from, to) => {
    const pendingIds = Array.from({ length: 12 }, (_, i) => `ask-${i}`);
    let pages = 0;
    const { latest } = await phone({
      entityPages: from,
      history: (fake, options) => {
        for (const id of pendingIds) fake.apply(asking, [ask(id, 30 * 1024, 0)]);
        answered(16, 40 * 1024)(fake);
        // After the first page, the daemon is another build.
        onPages(fake, (count) => {
          pages = count;
          if (count === 1) options.entityPages = to;
        });
      },
    });
    await vi.waitFor(() => {
      const row = latest(asking) as
        | { total: number; requests: { id: string; command: string }[] }
        | undefined;
      expect(row?.total).toBe(13);
      expect(new Set(row?.requests.map((request) => request.id)).size).toBe(8);
      const commands = new Set([
        "bun run test:changed --with-process",
        ...pendingIds.map((id) => `make ${id}`),
      ]);
      for (const request of row?.requests ?? []) expect(commands.has(request.command)).toBe(true);
    });
    expect(pages).toBeGreaterThan(1);
  },
);

it("a read that stops at its 200 pages counts what the daemon counts and says it read fewer", async () => {
  // 201 more pending requests of 70 KiB: one to a 64 KiB page, past the 200 pages a read takes.
  const { latest } = await phone({
    history: (fake) => {
      for (let index = 0; index < 201; index++)
        fake.apply(asking, [ask(`ask-${index}`, 70 * 1024, 0)]);
    },
  });
  await vi.waitFor(() =>
    expect(latest(asking)).toMatchObject({ total: 202, loaded: 200, more: true }),
  );
});

it("one pending request behind 200 pages of answered ones on an older daemon is counted, not claimed read", async () => {
  const { latest } = await phone({
    entityPages: "chronological",
    history: answered(200, 70 * 1024),
  });
  await vi.waitFor(() =>
    expect(latest(asking)).toMatchObject({ total: 1, loaded: 0, more: true, requests: [] }),
  );
});

it("a read that finds every request says nothing more waits", async () => {
  const { latest } = await phone({ history: answered(16, 40 * 1024) });
  await vi.waitFor(() =>
    expect(latest(asking)).toMatchObject({ total: 1, loaded: 1, more: false }),
  );
});
