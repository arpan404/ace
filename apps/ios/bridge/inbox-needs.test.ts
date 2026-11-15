import "./test-host.ts";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
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
    /** More history on the asking thread, after its first approval, before the phone starts. */
    history?: (daemon: FakeDaemon) => void;
  } = {},
) {
  const daemon = new FakeDaemon({
    clock: () => 1000,
    ...(setup.entityPages ? { entityPages: setup.entityPages } : {}),
  });
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
  setup.history?.(daemon);
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

/** One request on the asking thread, its provider frames `bytes` long. */
const ask = (id: string, bytes: number) => ({
  ...approval(id, `make ${id}`),
  raw: [{ type: "tool_use", data: { input: "x".repeat(bytes) } }],
});
const answer = (id: string) => ({
  type: "interaction.closed" as const,
  interaction: id,
  state: "resolved" as const,
  resolution: { kind: "approval" as const, optionId: `${id}:allow` },
});

it.each(
  (["active-first", "chronological"] as const).flatMap((entityPages) =>
    [1, 2, 3, 4, 5, 6].map((seed) => ({ entityPages, seed })),
  ),
)(
  "generated thread $seed: the row counts and shows the pending requests, whatever their number and size ($entityPages daemon)",
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
    const pending = new Set(["first"]);
    let made = 0;
    const history = (daemon: FakeDaemon) => {
      // Some threads hold more pending requests than one page's 200 entries.
      const count = seed % 3 === 0 ? r.int(201, 230) : r.int(0, 40);
      for (let index = 0; index < count; index++) {
        const id = `ask-${made++}`;
        daemon.apply(asking, [ask(id, seed % 3 === 0 ? r.int(10, 200) : bytes())]);
        pending.add(id);
        if (r.next() < 0.4) {
          daemon.apply(asking, [answer(id)]);
          pending.delete(id);
        }
      }
    };
    const { daemon, latest } = await phone({ entityPages, history });
    // While the phone reads: requests answered and new ones asked.
    for (let round = 0; round < 6; round++) {
      await new Promise((wake) => setTimeout(wake, r.int(0, 5)));
      for (const id of pending)
        if (r.next() < 0.05) {
          daemon.apply(asking, [answer(id)]);
          pending.delete(id);
        }
      if (r.next() < 0.5) {
        const id = `ask-${made++}`;
        daemon.apply(asking, [ask(id, bytes())]);
        pending.add(id);
      }
    }
    await vi.waitFor(
      () => {
        const row = latest(asking) as
          | { total: number; requests: { command: string }[] }
          | undefined;
        expect(row?.total).toBe(pending.size);
        expect(row?.requests).toHaveLength(Math.min(8, pending.size));
        // Each shown is pending, whole enough to answer: its command is its own.
        const commands = new Set(
          [...pending].map((id) =>
            id === "first" ? "bun run test:changed --with-process" : `make ${id}`,
          ),
        );
        for (const request of row?.requests ?? []) expect(commands.has(request.command)).toBe(true);
      },
      { timeout: 4000 },
    );
  },
);
