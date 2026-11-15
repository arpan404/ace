import { expect, it } from "vitest";
import { z } from "zod";
import { AgentId, ThreadId, type McpAttribution } from "@ace/protocol";
import type { SuitId, SuitLiveReport, SuitProblem } from "@ace/protocol/suits";
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
  /** What the devices report when asked to check a Suit as rendered. */
  const live: { reports: SuitLiveReport[]; asked: SuitId[] } = { reports: [], asked: [] };
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
    async liveCheck(_caller, id) {
      live.asked.push(id);
      return live.reports.filter((report) => report.suitId === id);
    },
  };
  return { port, devices, live, shows: () => devices.preview ?? devices.kept };
}

const Result = z.object({
  status: z.string(),
  suit: z.string().nullable(),
  problems: z.array(
    z.object({ check: z.string(), field: z.string().nullable(), message: z.string() }),
  ),
  next: z.string(),
  live: z.object({ source: z.string(), devices: z.array(z.string()) }).optional(),
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
    turnEnded: (thread: string) => previews.turnEnded(thread),
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
      const images = (result.content ?? []).filter((part) => part.type === "image");
      return {
        failed: result.isError === true,
        images,
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
  const suits = tool({ "arcade-cabinet": [] });
  expect((await suits.apply({ mode: "preview", id: "arcade-cabinet" })).status).toBe("previewing");
  expect(suits.shows()).toBe("arcade-cabinet");
  expect((await suits.apply({ mode: "revert" })).status).toBe("reverted");
  expect(suits.shows()).toBeNull();
});

it("a preview nobody keeps ends with its own thread's turn, not another thread's", async () => {
  const suits = tool({ "arcade-cabinet": [] });
  await suits.apply({ mode: "preview", id: "arcade-cabinet" }, "thread-a");
  await suits.turnEnded("thread-b");
  expect(suits.shows()).toBe("arcade-cabinet");
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBeNull();
});

it("keep stores the agent's preview, and one revert brings back the look from before", async () => {
  const suits = tool({ "arcade-cabinet": [], "quiet-ledger": [] });
  await suits.apply({ mode: "preview", id: "quiet-ledger" });
  await suits.apply({ mode: "keep" });
  await suits.apply({ mode: "preview", id: "arcade-cabinet" });
  expect((await suits.apply({ mode: "keep" })).suit).toBe("arcade-cabinet");
  // A kept Suit outlives the turn.
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBe("arcade-cabinet");
  expect((await suits.apply({ mode: "revert" })).status).toBe("reverted");
  expect(suits.shows()).toBe("quiet-ledger");
});

it("keep re-checks the folder, so a Suit edited into failing after its preview is refused", async () => {
  const suits = tool({ "arcade-cabinet": [] });
  await suits.apply({ mode: "preview", id: "arcade-cabinet" });
  suits.library["arcade-cabinet"] = [contrast];
  const kept = await suits.apply({ mode: "keep" });
  expect(kept.status).toBe("refused");
  expect(suits.devices.kept).toBeNull();
});

it("another thread's preview replaces the first, and the first thread can no longer end it", async () => {
  const suits = tool({ "arcade-cabinet": [], "quiet-ledger": [] });
  await suits.apply({ mode: "preview", id: "arcade-cabinet" }, "thread-a");
  await suits.apply({ mode: "preview", id: "quiet-ledger" }, "thread-b");
  const revert = await suits.apply({ mode: "revert" }, "thread-a");
  expect(revert.status).toBe("nothing-to-do");
  await suits.turnEnded("thread-a");
  expect(suits.shows()).toBe("quiet-ledger");
});

it("an unknown Suit, or keep with nothing previewed, tells the agent what to pass", async () => {
  const suits = tool({});
  const missing = await suits.apply({ mode: "preview", id: "no-such-suit" });
  expect(missing).toMatchObject({ failed: true, status: "not-found" });
  const keep = await suits.apply({ mode: "keep" });
  expect(keep).toMatchObject({ failed: true, status: "nothing-to-do" });
});

const report = (overrides: Partial<SuitLiveReport>): SuitLiveReport => ({
  checkId: "check-1",
  suitId: "neon-dusk",
  client: "desktop",
  scheme: "dark",
  widths: [1440, 1024, 760],
  problems: [],
  unchecked: [],
  screenshot: null,
  ...overrides,
});

it("a preview comes back with what the devices saw as rendered, and their screenshots as images", async () => {
  const suits = tool({ "neon-dusk": [] });
  const covered: SuitProblem = {
    scheme: "dark",
    check: "protected",
    field: "working-line",
    message: "working-line is covered at its centre by something else.",
  };
  suits.live.reports = [
    report({
      problems: [covered],
      screenshot: { mimeType: "image/jpeg", data: "AAAA", width: 1440, height: 900 },
    }),
  ];
  const result = await suits.apply({ mode: "preview", id: "neon-dusk" });
  expect(result).toMatchObject({ failed: false, status: "previewing" });
  expect(result.problems).toEqual([
    expect.objectContaining({ check: "protected", field: "working-line" }),
  ]);
  expect(result.live).toEqual({ source: "live", devices: ["desktop, dark, at 1440/1024/760 px"] });
  expect(result.images).toEqual([{ type: "image", mimeType: "image/jpeg", data: "AAAA" }]);
  // Live problems don't take the preview down: the person sees it while the agent fixes it.
  expect(suits.shows()).toBe("neon-dusk");
});

it("when no device answers the live check, the preview says only the static checks ran", async () => {
  const suits = tool({ "arcade-cabinet": [] });
  const result = await suits.apply({ mode: "preview", id: "arcade-cabinet" });
  expect(result.live?.source).toBe("static");
  expect(result.next).toMatch(/only the static checks ran/);
  expect(result.images).toEqual([]);
});

it("a refused Suit is never sent to the devices to check", async () => {
  const suits = tool({ "neon-dusk": [contrast] });
  await suits.apply({ mode: "preview", id: "neon-dusk" });
  expect(suits.live.asked).toEqual([]);
});
