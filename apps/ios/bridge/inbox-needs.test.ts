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
async function phone() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
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
