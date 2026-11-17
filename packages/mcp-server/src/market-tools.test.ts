import { expect, it } from "vitest";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { CredentialRegistry, ToolRegistry, marketToolkit } from "./index.ts";

const hash = "c".repeat(64);
const listing = {
  title: "Dusk Harbor",
  line: "A calm dark look.",
  description: "",
  categories: [],
  keywords: ["dark"],
  links: [],
  previews: [],
};

/** The daemon's market as the tools reach it: answers by operation, and what was asked. */
function market(answers: (operation: MarketOperation) => MarketResult) {
  const asked: { thread: string; operation: MarketOperation }[] = [];
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  marketToolkit({
    async request(caller, operation) {
      asked.push({ thread: caller.threadId, operation });
      return answers(operation);
    },
  }).register(registry);
  const credentials = new CredentialRegistry(() => "1".padStart(64, "0"));
  const { principal } = credentials.issue(
    {
      sessionId: "session-a",
      threadId: ThreadId.parse("thread-a"),
      agentId: AgentId.parse("root"),
      capabilities: [],
    },
    new AbortController().signal,
  );
  return {
    asked,
    tools: () => registry.list(principal),
    async call(name: string, input: Record<string, unknown>) {
      const result = await registry.call(name, input, principal, new AbortController().signal);
      const text = result.content?.find((part) => part.type === "text");
      return {
        failed: result.isError === true,
        body: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(text?.type === "text" ? text.text : "{}")),
      };
    },
  };
}

it("market_read is a read and market_publish reaches the world, and Spade reads publish from it", () => {
  const tools = market(() => ({ op: "installed", installed: [] })).tools();
  const read = tools.find((tool) => tool.name === "market_read");
  const publish = tools.find((tool) => tool.name === "market_publish");
  expect(read?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(read).toHaveProperty(["_meta", "ace/effect"], "read");
  expect(publish?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  expect(publish).toHaveProperty(["_meta", "ace/effect"], "publish");
});

it("a search asks the daemon as the calling thread and answers with its entries", async () => {
  const world = market(() => ({ op: "search", entries: [], total: 0 }));
  const answer = await world.call("market_read", {
    verb: "search",
    query: "linear",
    type: "spade-plugin",
  });
  expect(answer).toEqual({ failed: false, body: { op: "search", entries: [], total: 0 } });
  expect(world.asked).toEqual([
    {
      thread: "thread-a",
      operation: { op: "search", query: "linear", type: "spade-plugin", offset: 0, limit: 50 },
    },
  ]);
});

it("a withdrawal is the person's: the agent reads the request ace opened, not a failure", async () => {
  const world = market(() => ({
    op: "error",
    code: "person_only",
    message: "Withdrawing is yours to do. ace asked you in this thread.",
    request: "int_9",
  }));
  const answer = await world.call("market_publish", {
    verb: "withdraw",
    type: "suit",
    name: "dusk-harbor",
    version: "1.1.0",
    reason: "Contrast fails",
  });
  expect(answer.failed).toBe(false);
  expect(answer.body).toMatchObject({ status: "person", request: "int_9" });
});

it("a refusal from the market is a failed call carrying its sentence", async () => {
  const world = market(() => ({ op: "error", code: "signed_out", message: "Sign in to publish." }));
  const answer = await world.call("market_publish", {
    verb: "draft_publish",
    draft: "drf_abcdefgh",
  });
  expect(answer).toEqual({
    failed: true,
    body: { code: "signed_out", message: "Sign in to publish." },
  });
});

it("a verb missing what it needs says which field, and asks nothing", async () => {
  const world = market(() => ({ op: "done" }));
  const answer = await world.call("market_publish", {
    verb: "deprecate",
    type: "suit",
    name: "dusk-harbor",
  });
  expect(answer).toMatchObject({ failed: true, body: { code: "invalid", field: "version" } });
  expect(world.asked).toEqual([]);
});

it("describe changes only the words given, over the entry's current listing", async () => {
  const world = market((operation) =>
    operation.op === "publish" && operation.request.action === "entry"
      ? {
          op: "publish",
          answer: {
            kind: "entry",
            entry: {
              summary: {
                type: "suit",
                name: "dusk-harbor",
                title: "Dusk Harbor",
                line: listing.line,
                versions: 1,
                visibility: "listed",
                archived: false,
                pinned: false,
                reviewed: true,
                downloads: 0,
                pendingListing: false,
                openReports: 0,
              },
              listing,
              versions: [],
            },
          },
        }
      : { op: "publish", answer: { kind: "done" } },
  );
  await world.call("market_publish", {
    verb: "describe",
    type: "suit",
    name: "dusk-harbor",
    line: "Calmer.",
  });
  expect(world.asked.at(-1)?.operation).toEqual({
    op: "publish",
    request: {
      action: "listing",
      type: "suit",
      name: "dusk-harbor",
      listing: { ...listing, line: "Calmer." },
    },
  });
});

it("a draft from a folder whose check flags texts waits for the agent to confirm them", async () => {
  const check = {
    files: [{ path: "suit.json", bytes: 10, binary: false }],
    excluded: [],
    findings: [
      {
        path: "suit.json",
        kind: "email" as const,
        text: "me@example.com",
        sentence: "suit.json holds an email address.",
        blocking: false,
      },
    ],
    hash,
  };
  const world = market((operation) =>
    operation.op === "publish" && operation.request.action === "draftCheck"
      ? { op: "publish", answer: { kind: "checked", check } }
      : { op: "publish", answer: { kind: "done" } },
  );
  const draft = {
    verb: "draft_create",
    type: "suit",
    name: "dusk-harbor",
    version: "1.2.0",
    path: "/tmp/dusk",
  };
  const first = await world.call("market_publish", draft);
  expect(first.body).toMatchObject({
    status: "confirm",
    findings: ["suit.json holds an email address."],
  });
  expect(
    world.asked.some(
      ({ operation }) => operation.op === "publish" && operation.request.action === "draftCreate",
    ),
  ).toBe(false);

  await world.call("market_publish", { ...draft, confirm: true });
  expect(world.asked.at(-1)?.operation).toMatchObject({
    request: {
      action: "draftCreate",
      checked: { hash, binaries: [], accepted: ["me@example.com"] },
    },
  });
});

it("install prepares a review, then asks to install exactly the reviewed hash", async () => {
  const world = market((operation) =>
    operation.op === "prepare"
      ? {
          op: "review",
          review: {
            id: "rv-1",
            source: "market",
            type: "suit",
            name: "dusk-harbor",
            title: "Dusk Harbor",
            version: "1.2.0",
            hash,
            signed: true,
            reviewed: true,
            byAce: false,
            body: { type: "suit", passes: true, problems: [], scenes: [], fonts: [], files: 1 },
            expiresAt: 0,
            items: 0,
          },
        }
      : {
          op: "error",
          code: "person_only",
          message: "Installing is yours to do.",
          request: "int_2",
        },
  );
  const answer = await world.call("market_publish", {
    verb: "install",
    type: "suit",
    name: "dusk-harbor",
  });
  expect(answer.body).toMatchObject({ status: "person", request: "int_2" });
  expect(world.asked.at(-1)?.operation).toEqual({
    op: "install",
    id: "rv-1",
    hash,
    choices: { bots: [], needs: {}, startRoutines: false },
  });
});
