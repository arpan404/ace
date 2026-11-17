import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import { agentRoute, type AgentFacts } from "./agent-gate.ts";
import { agentMarketRequest } from "./agent-requests.ts";

const facts: AgentFacts = { agent: "Codex", askBeforePublish: false };
const publish = (
  request: Extract<MarketOperation, { op: "publish" }>["request"],
): MarketOperation => ({
  op: "publish",
  request,
});
const entry = { type: "suit", name: "dusk-harbor" } as const;

describe("which market requests an agent may make itself", () => {
  // The allowlist (ADR 0178 §12.5): reads, local checks, the draft-and-publish flow, status and
  // versions. Everything else is the person's, so an operation added later starts as theirs.
  const theirs: [string, MarketOperation][] = [
    [
      "a draft",
      publish({
        action: "draftCreate",
        ...entry,
        version: "1.2.0",
        source: { kind: "suit", id: "dusk-harbor" },
      }),
    ],
    ["reading a draft", publish({ action: "draftRead", id: "drf_abcdefgh" })],
    ["deleting an unpublished draft", publish({ action: "draftDelete", id: "drf_abcdefgh" })],
    ["publishing a draft", publish({ action: "draftPublish", id: "drf_abcdefgh" })],
    ["their status", publish({ action: "me" })],
    ["an entry's versions", publish({ action: "entry", ...entry })],
    ["a search", { op: "search", query: "", offset: 0, limit: 50 }],
    ["reading an entry", { op: "read", source: "market", ...entry }],
    ["preparing a review", { op: "prepare", source: "market", ...entry }],
    ["what's installed", { op: "installed" }],
    ["the sources", { op: "sources" }],
    ["discover", { op: "discover" }],
  ];
  it.each(theirs)("%s runs under the provider's permissions", (_what, operation) => {
    expect(agentRoute(operation, facts)).toEqual({ kind: "run" });
  });

  const persons: [string, MarketOperation][] = [
    [
      "withdraw",
      publish({ action: "withdraw", ...entry, version: "1.2.0", reason: "Contrast fails" }),
    ],
    ["transfer", publish({ action: "transfer", ...entry, to: "rijan" })],
    [
      "accepting a transfer",
      publish({ action: "transferAnswer", id: "trf_abcdefgh", accept: true }),
    ],
    ["a handle change", publish({ action: "changeHandle", handle: "newname" })],
    ["deleting an entry", publish({ action: "deleteEntry", ...entry })],
    ["applying for verification", publish({ action: "applyVerification" })],
    ["checking verification", publish({ action: "checkVerification" })],
    [
      "installing",
      {
        op: "install",
        id: "rv-1",
        hash: "a".repeat(64),
        choices: { bots: [], needs: {}, startRoutines: false },
      },
    ],
    ["turning a withdrawn entry back on", { op: "turnOn", ...entry }],
    ["removing an installed entry", { op: "remove", ...entry }],
    ["adding a source", { op: "addSource", address: "https://example.com/market" }],
    ["removing a source", { op: "removeSource", id: "market" }],
    ["turning a source off", { op: "setSource", id: "market", enabled: false }],
    ["turning a source on", { op: "setSource", id: "market", enabled: true }],
    ["hiding an entry", publish({ action: "visibility", ...entry, visibility: "unlisted" })],
    ["choosing the latest version", publish({ action: "latest", ...entry, version: "1.0.0" })],
    ["archiving", publish({ action: "archive", ...entry, archived: true })],
    [
      "listing words",
      publish({
        action: "listing",
        ...entry,
        listing: {
          title: "Dusk",
          line: "",
          description: "",
          categories: [],
          keywords: [],
          links: [],
          previews: [],
        },
      }),
    ],
    [
      "a deprecation",
      publish({ action: "deprecate", ...entry, version: "1.2.0", note: "Use 2.0" }),
    ],
    ["an appeal", publish({ action: "appeal", ...entry, version: "1.2.0", note: "Fixed" })],
    ["any profile edit", publish({ action: "editProfile", profile: { bio: "Hi" } })],
    ["a report", { op: "report", ...entry, reason: "malware", note: "" }],
  ];
  it.each(persons)("%s is the person's, asked in their words", (_what, operation) => {
    const route = agentRoute(operation, facts);
    expect(route.kind).toBe("person");
    if (route.kind === "person") {
      expect(route.ask.title).toMatch(/^Codex asks you to \S/);
      expect(route.ask.refusal).toMatch(/ is yours to do\. ace asked you in this thread\.$/);
    }
  });

  it("names what it withdraws and why, as the strip says it", () => {
    const route = agentRoute(
      publish({
        action: "withdraw",
        ...entry,
        version: "1.2.0",
        reason: "the colours fail contrast.",
      }),
      facts,
    );
    expect(route).toEqual({
      kind: "person",
      ask: {
        title: "Codex asks you to withdraw suit/dusk-harbor 1.2.0: the colours fail contrast.",
        action: "Withdraw…",
        refusal: "Withdrawing is yours to do. ace asked you in this thread.",
      },
    });
  });

  it("Ask me before agents publish makes publishing a draft the person's, and nothing else", () => {
    const on = { ...facts, askBeforePublish: true };
    expect(agentRoute(publish({ action: "draftPublish", id: "drf_abcdefgh" }), on).kind).toBe(
      "person",
    );
    expect(agentRoute(publish({ action: "me" }), on).kind).toBe("run");
  });
});

/** The daemon an agent reaches: what ran, and which requests opened. */
function daemon(options: { thread?: boolean; ask?: boolean } = {}) {
  const ran: MarketOperation[] = [];
  const opened: string[] = [];
  return {
    ran,
    opened,
    deps: {
      run: async (operation: MarketOperation) => {
        ran.push(operation);
        return { op: "done" } as const;
      },
      requests: () => ({
        open: (_thread: string, ask: { title: string }) => {
          opened.push(ask.title);
          return options.thread === false ? undefined : "int_1";
        },
      }),
      askBeforePublish: async () => options.ask ?? false,
      agentName: () => "Claude Code",
    },
  };
}

describe("an agent's market request", () => {
  it("a withdrawal opens the person's request and runs nothing", async () => {
    const world = daemon();
    const result = await agentMarketRequest(
      world.deps,
      "thread-1",
      publish({ action: "withdraw", ...entry, reason: "Broken" }),
    );
    expect(result).toEqual({
      op: "error",
      code: "person_only",
      message: "Withdrawing is yours to do. ace asked you in this thread.",
      request: "int_1",
    });
    expect(world.ran).toEqual([]);
    expect(world.opened).toEqual(["Claude Code asks you to withdraw suit/dusk-harbor: Broken."]);
  });

  it("a person-only action from a thread that isn't here is refused without a request", async () => {
    const world = daemon({ thread: false });
    const result = await agentMarketRequest(
      world.deps,
      "gone",
      publish({ action: "deleteEntry", ...entry }),
    );
    expect(result).toMatchObject({ op: "error", code: "person_only" });
    expect(result).not.toHaveProperty("request");
    expect(world.ran).toEqual([]);
  });

  it("a publish runs as asked when the person hasn't asked to be asked", async () => {
    const world = daemon();
    const operation = publish({ action: "draftPublish", id: "drf_abcdefgh" });
    expect(await agentMarketRequest(world.deps, "thread-1", operation)).toEqual({ op: "done" });
    expect(world.ran).toEqual([operation]);
  });

  it("with the setting on, a publish waits for the person", async () => {
    const world = daemon({ ask: true });
    const result = await agentMarketRequest(
      world.deps,
      "thread-1",
      publish({ action: "draftPublish", id: "drf_abcdefgh" }),
    );
    expect(result).toMatchObject({ code: "person_only", request: "int_1" });
    expect(world.ran).toEqual([]);
  });
});
