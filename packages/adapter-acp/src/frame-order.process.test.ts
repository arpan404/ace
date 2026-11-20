// Real ACP child process: session I/O and the translator must agree on frames that share one read.
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { spawnSupervised } from "@ace/provider-kit/process";
import {
  openAcpSession,
  createAcpTranslator,
  antigravityQuirks,
  createTranslatorIdentity,
} from "./index.ts";
import { extensionQuirks } from "./testing/extension-quirks.ts";
import { nativeAgentKey } from "./keys.ts";
import { object } from "./data.ts";
const server = fileURLToPath(new URL("./testing/frame-order-server.ts", import.meta.url));
const threadId = ThreadId.parse("frame-order");
interface Options {
  quirks?: typeof extensionQuirks;
  resume?: boolean;
  server?: { name?: string; resumeOnly?: boolean; hangOpen?: boolean };
  mcp?: { configuredServers: unknown[] };
}
function harness(options: Options = {}) {
  const quirks = options.quirks ?? extensionQuirks;
  const state = createThreadState({
    threadId,
    config: { provider: quirks.provider, silenceMs: 90_000 },
  });
  const translator = createAcpTranslator(
    { threadId, rootKey: "root", identity: createTranslatorIdentity("frame-order") },
    quirks,
  );
  const frames: Frame[] = [];
  const watchers = new Set<() => void>();
  const timers: { delay: number; run(): void; cancelled: boolean }[] = [];
  const metadata: unknown[] = [];
  let ids = 0;
  let clock = 0;
  const { promise: exited, resolve: exit } = Promise.withResolvers<{ deliberate: boolean }>();
  const opening = openAcpSession(
    {
      threadId,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      ...(options.resume ? { resume: { nativeSessionId: "fo-root" } } : {}),
      ...(options.mcp ? { mcp: { ...options.mcp, httpServers: [], secrets: [], end() {} } } : {}),
      onFrame(frame) {
        frames.push(frame);
        for (const fact of translator.translate(frame, clock))
          apply(state, fact, { now: clock, ids: { next: () => `id-${++ids}` } });
        for (const watcher of watchers) watcher();
      },
      onSessionMetadata: (raw: unknown) => metadata.push(raw),
      onExit: exit,
    },
    quirks,
    {
      command: process.execPath,
      args: [server],
      env: { ...process.env, ACE_FRAME_ORDER: JSON.stringify(options.server ?? {}) },
      version: "1.2.1",
    },
    {
      spawn: spawnSupervised,
      now: () => clock,
      schedule(delay, run) {
        const timer = { delay, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  );
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve) => {
      const check = () => {
        const found = frames.find(predicate);
        if (!found) return;
        watchers.delete(check);
        resolve(found);
      };
      watchers.add(check);
      check();
    });
  }
  /** Passes time to `ms`: the session's armed deadlines of that length fire, the translator ticks. */
  function elapse(ms: number) {
    clock += ms;
    for (const timer of timers.splice(0))
      if (!timer.cancelled && timer.delay === ms) timer.run();
      else if (!timer.cancelled) timers.push(timer);
    for (const fact of [...translator.tick(clock), { type: "tick" as const }])
      apply(state, fact, { now: clock, ids: { next: () => `id-${++ids}` } });
  }
  return { opening, state, frames, wait, elapse, exited, metadata };
}
async function open(options: Options = {}) {
  const h = harness(options);
  return { ...h, session: await h.opening };
}
const input = (text: string) => [{ type: "text" as const, text }];
const sent = (frames: Frame[], name: string) =>
  frames.filter((frame) => frame.dir === "send" && object(frame.data)["method"] === name);
const updateOf = (frame: Frame) => object(object(object(frame.data)["params"])["update"]);
/** Fails instead of hanging when the session never takes the input. */
const taken = (promise: Promise<void>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("input was never taken")), 2_000),
    ),
  ]);
async function closing(session: ProviderSession, run: () => Promise<void>) {
  try {
    await run();
  } finally {
    await session.close("shutdown");
  }
}

it("an error reply sharing a read with an approval closes it, and the next input goes out", async () => {
  const h = await open();
  await closing(h.session, async () => {
    await expect(h.session.send(input("error-approval"), "queue")).rejects.toThrow();
    await taken(h.session.send(input("next"), "queue"));
    expect(sent(h.frames, "session/prompt")).toHaveLength(2);
    expect(Object.values(h.state.interactions).map((i) => i.state)).toEqual(["cancelled"]);
  });
});

it("an approval-first shell that was allowed still holds input once the prompt ends", async () => {
  const h = await open({ quirks: antigravityQuirks, server: { name: "antigravity-acp" } });
  await closing(h.session, async () => {
    const first = h.session.send(input("approval-first"), "queue");
    await h.wait((frame) => object(frame.data)["method"] === "session/request_permission");
    await h.session.resolve("request:number:201", { kind: "approval", optionId: "a" });
    await first;
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    expect(sent(h.frames, "session/prompt")).toHaveLength(1);
  });
});

it("a tool still running after the prompt's reply holds the next input until it settles", async () => {
  const h = await open();
  await closing(h.session, async () => {
    await h.session.send(input("post-reply"), "queue");
    expect(h.state.status.state).toBe("working");
    await taken(h.session.send(input("next"), "queue"));
    const settled = h.frames.findIndex((frame) => updateOf(frame)["status"] === "completed");
    const second = h.frames.indexOf(sent(h.frames, "session/prompt")[1] as Frame);
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(second);
    expect(h.state.status.state).toBe("done");
  });
});

it("live work right after a load's reply in the same read is not taken for replay", async () => {
  const h = await open({ resume: true });
  await closing(h.session, async () => {
    expect(h.state.status.state).toBe("working");
    await taken(h.session.send(input("next"), "queue"));
    const settled = h.frames.findIndex(
      (frame) =>
        updateOf(frame)["toolCallId"] === "live" && updateOf(frame)["status"] === "completed",
    );
    const prompt = h.frames.indexOf(sent(h.frames, "session/prompt")[0] as Frame);
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(prompt);
    expect(h.state.status.state).toBe("done");
  });
});

it.each([
  ["new", false],
  ["loaded", true],
])(
  "options reported while a %s session opens survive a reply that names none",
  async (_, resume) => {
    const h = await open({ resume });
    await closing(h.session, async () => {
      expect(object(h.metadata.at(-1))["configOptions"]).toEqual([
        expect.objectContaining({ id: "model", currentValue: "model-a" }),
      ]);
    });
  },
);

it("an end-only tool frame after a child completed does not bring it back to hold input", async () => {
  const h = await open();
  await closing(h.session, async () => {
    await h.session.send(input("child-resurrect"), "queue");
    await taken(h.session.send(input("next"), "queue"));
    expect(sent(h.frames, "session/prompt")).toHaveLength(2);
    expect(h.state.status.state).toBe("done");
  });
});

it("a cancelled child that never answers is given up after the grace, and input goes out", async () => {
  const h = await open();
  await closing(h.session, async () => {
    await h.session.send(input("child-silent"), "queue");
    const next = h.session.send(input("next"), "queue");
    await h.session.interrupt({ agent: nativeAgentKey(threadId, "quiet"), cascade: false });
    expect(sent(h.frames, "session/prompt")).toHaveLength(1);
    h.elapse(12_000);
    await taken(next);
    expect(sent(h.frames, "session/prompt")).toHaveLength(2);
    expect(h.state.status.state).toBe("done");
  });
});

it("a stop the agent never answers ends the session after the grace", async () => {
  const h = await open();
  await closing(h.session, async () => {
    const hung = h.session.send(input("hang"), "queue");
    await h.wait((frame) => sent([frame], "session/prompt").length > 0);
    await h.session.interrupt({ cascade: false });
    h.elapse(12_000);
    await expect(hung).rejects.toThrow();
    expect((await h.exited).deliberate).toBe(false);
  });
});

it("a cancelled shell the agent never reports again ends the session after the grace", async () => {
  const h = await open();
  await closing(h.session, async () => {
    await h.session.send(input("cancel-shell"), "queue");
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    h.elapse(12_000);
    expect((await h.exited).deliberate).toBe(false);
  });
});

it("an agent that only offers session/resume reopens a saved session with it", async () => {
  const h = await open({ resume: true, server: { resumeOnly: true } });
  await closing(h.session, async () => {
    expect(sent(h.frames, "session/resume")).toHaveLength(1);
    expect(sent(h.frames, "session/load")).toHaveLength(0);
  });
});

it("opening fails when the agent stays silent past the stall deadline", async () => {
  const h = harness({ server: { hangOpen: true } });
  await h.wait((frame) => sent([frame], "session/new").length > 0);
  h.elapse(30_000);
  await expect(h.opening).rejects.toThrow();
});

it("a configured HTTP MCP server the agent can't take is left out with a notice", async () => {
  const h = await open({
    mcp: {
      configuredServers: [
        { name: "remote", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] },
        { name: "local", command: "/bin/true", args: [], env: [] },
      ],
    },
  });
  await closing(h.session, async () => {
    const servers = object(object(sent(h.frames, "session/new")[0]?.data)["params"])["mcpServers"];
    expect(servers).toEqual([expect.objectContaining({ name: "local" })]);
    const notices = Object.values(h.state.items).filter((item) => item.type === "notice");
    expect(notices.map((item) => (item.type === "notice" ? item.text : ""))).toContainEqual(
      expect.stringContaining('"remote"'),
    );
  });
});
