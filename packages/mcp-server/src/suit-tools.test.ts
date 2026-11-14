import { expect, it } from "vitest";
import { z } from "zod";
import { AgentId, ThreadId, type McpAttribution } from "@ace/protocol";
import type { SuitId, SuitProblem } from "@ace/protocol/suits";
import {
  CredentialRegistry,
  SuitPreviews,
  ToolRegistry,
  suitToolkit,
  type SuitPort,
} from "./index.ts";

const contrast: SuitProblem = {
  scheme: "dark",
  check: "contrast",
  field: "muted",
  message: "Secondary text is 3.1:1 on raised; it needs 4.5:1.",
};

/** The daemon as the tool sees it: a library on disk and what the person's devices show. */
function daemon(library: Record<string, SuitProblem[]>) {
  const devices = { kept: null as SuitId | null, preview: null as SuitId | null };
  const port: SuitPort = {
    async validate(id) {
      const problems = library[id];
      if (!problems) return undefined;
      return {
        id,
        name: id,
        description: "",
        schemes: ["dark"],
        scene: false,
        contentHash: id,
        problems,
      };
    },
    async preview(_caller, id) {
      devices.preview = id;
    },
    async keep(_caller, id) {
      const before = devices.kept;
      devices.kept = id;
      devices.preview = null;
      return {
        async restore() {
          devices.kept = before;
        },
      };
    },
  };
  return { port, devices, shows: () => devices.preview ?? devices.kept };
}

const Result = z.object({
  status: z.string(),
  suit: z.string().nullable(),
  problems: z.array(z.object({ field: z.string().nullable(), message: z.string() })),
});

const caller = (thread: string): McpAttribution => ({
  sessionId: `session-${thread}`,
  threadId: ThreadId.parse(thread),
  agentId: AgentId.parse("root"),
});

function tool(library: Record<string, SuitProblem[]>) {
  const world = daemon(library);
  const previews = new SuitPreviews(world.port);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  suitToolkit(previews).register(registry);
  let bearers = 0;
  const credentials = new CredentialRegistry(() => (++bearers).toString(16).padStart(64, "0"));
  const principals = new Map<string, ReturnType<typeof credentials.issue>["principal"]>();
  return {
    ...world,
    library,
    turnEnded: (thread: string) => previews.turnEnded(caller(thread)),
    async apply(args: { mode: string; id?: string }, thread = "thread-a") {
      const principal =
        principals.get(thread) ??
        credentials.issue({ ...caller(thread), capabilities: [] }, new AbortController().signal)
          .principal;
      principals.set(thread, principal);
      const result = await registry.call(
        "suit_apply",
        args,
        principal,
        new AbortController().signal,
      );
      return {
        failed: result.isError === true,
        ...Result.parse(result.structuredContent),
      };
    },
  };
}

it("a Suit that fails its checks is refused with every problem, and the devices keep their look", async () => {
  const suits = tool({ "neon-dusk": [contrast] });
  const result = await suits.apply({ mode: "preview", id: "neon-dusk" });
  expect(result.failed).toBe(true);
  expect(result.status).toBe("refused");
  expect(result.problems).toEqual([expect.objectContaining({ field: "muted" })]);
  expect(suits.shows()).toBeNull();
});

it("a preview shows over the kept look until the agent reverts it", async () => {
  const suits = tool({ "warm-paper": [] });
  expect((await suits.apply({ mode: "preview", id: "warm-paper" })).status).toBe("previewing");
  expect(suits.shows()).toBe("warm-paper");
  expect((await suits.apply({ mode: "revert" })).status).toBe("reverted");
  expect(suits.shows()).toBeNull();
});

it("a preview nobody keeps ends with its own thread's turn, not another thread's", async () => {
  const suits = tool({ "warm-paper": [] });
  await suits.apply({ mode: "preview", id: "warm-paper" }, "thread-a");
  await suits.turnEnded("thread-b");
  expect(suits.shows()).toBe("warm-paper");
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBeNull();
});

it("keep stores the agent's preview, and one revert brings back the look from before", async () => {
  const suits = tool({ "warm-paper": [], starfield: [] });
  await suits.apply({ mode: "preview", id: "starfield" });
  await suits.apply({ mode: "keep" });
  await suits.apply({ mode: "preview", id: "warm-paper" });
  expect((await suits.apply({ mode: "keep" })).suit).toBe("warm-paper");
  // A kept Suit outlives the turn.
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBe("warm-paper");
  expect((await suits.apply({ mode: "revert" })).status).toBe("reverted");
  expect(suits.shows()).toBe("starfield");
});

it("keep re-checks the folder, so a Suit edited into failing after its preview is refused", async () => {
  const suits = tool({ "warm-paper": [] });
  await suits.apply({ mode: "preview", id: "warm-paper" });
  suits.library["warm-paper"] = [contrast];
  const kept = await suits.apply({ mode: "keep" });
  expect(kept.status).toBe("refused");
  expect(suits.devices.kept).toBeNull();
});

it("another thread's preview replaces the first, and the first thread can no longer end it", async () => {
  const suits = tool({ "warm-paper": [], starfield: [] });
  await suits.apply({ mode: "preview", id: "warm-paper" }, "thread-a");
  await suits.apply({ mode: "preview", id: "starfield" }, "thread-b");
  const revert = await suits.apply({ mode: "revert" }, "thread-a");
  expect(revert.status).toBe("nothing-to-do");
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBe("starfield");
});

it("an unknown Suit, or keep with nothing previewed, tells the agent what to pass", async () => {
  const suits = tool({});
  const missing = await suits.apply({ mode: "preview", id: "no-such-suit" });
  expect(missing).toMatchObject({ failed: true, status: "not-found" });
  const keep = await suits.apply({ mode: "keep" });
  expect(keep).toMatchObject({ failed: true, status: "nothing-to-do" });
});
