import { describe, expect, it } from "vitest";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import type {
  MarketDraft,
  MarketEntrySummary,
  MarketInstalled,
  MarketOperation,
  MarketResult,
  MarketReview,
} from "@ace/protocol/marketplace";
import { commandTable } from "../commands/table.ts";
import { installReviewed } from "./install.ts";
import { printed } from "./output.ts";
import { marketFailure, type MarketAnswer } from "./request.ts";

const hash = "b".repeat(64);
const summary: MarketEntrySummary = {
  source: "market",
  type: "suit",
  name: "dusk-harbor",
  title: "Dusk Harbor",
  line: "A calm dark look.",
  categories: [],
  keywords: [],
  version: "1.2.0",
  reviewed: true,
  byAce: false,
  updated: 0,
  downloads: 3,
  supported: true,
};
const installed: MarketInstalled = {
  source: "market",
  type: "suit",
  name: "dusk-harbor",
  title: "Dusk Harbor",
  version: "1.2.0",
  hash,
  acceptedAt: 1,
  state: "on",
};
const draft: MarketDraft = {
  id: "drf_abcdefgh",
  type: "suit",
  name: "dusk-harbor",
  version: "1.2.0",
  hash,
  size: 2048,
  files: 3,
  created: 0,
  updated: 0,
  changelog: "",
  title: "Dusk Harbor",
  problems: [],
  scan: { state: "scanning", read: 0, files: 3 },
};

const table = commandTable();
const outputOf = (id: string) => {
  const key = table.byId.get(id)?.output;
  if (!key || !(key in cliOutputs)) throw new Error(`${id} has no output schema`);
  return cliOutputs[key as keyof typeof cliOutputs];
};

describe("--json prints each answer's data, and it matches the command's schema", () => {
  it.each<[string, MarketAnswer]>([
    ["market.search", { op: "search", entries: [summary], total: 1 }],
    ["market.show", { op: "read", entry: { summary, description: "", versions: [] } }],
    [
      "market.show",
      {
        op: "publisher",
        page: {
          profile: {
            id: "p",
            handle: "arpan",
            displayName: "Arpan",
            bio: "",
            links: [],
            joined: 0,
            verified: false,
            proofs: [],
            pins: [],
          },
          pinned: [],
          entries: [summary],
          downloads: 3,
        },
      },
    ],
    ["market.installed", { op: "installed", installed: [installed] }],
    ["market.remove", { op: "done" }],
    [
      "market.source.list",
      {
        op: "sources",
        sources: [
          {
            id: "market",
            kind: "market",
            address: "https://market.acehq.dev",
            enabled: true,
            entries: 4,
          },
        ],
      },
    ],
    ["market.draft.show", { op: "publish", answer: { kind: "draft", draft } }],
    [
      "market.draft.publish",
      {
        op: "publish",
        answer: {
          kind: "published",
          type: "suit",
          name: "dusk-harbor",
          version: "1.2.0",
          held: false,
        },
      },
    ],
    ["market.withdraw", { op: "publish", answer: { kind: "pending", what: "withdrawal" } }],
  ])("%s", (id, answer) => {
    const { value } = printed(answer);
    expect(value).not.toHaveProperty("op");
    expect(outputOf(id).safeParse(value).error?.issues ?? []).toEqual([]);
  });
});

describe("the market's refusals as the CLI reports them", () => {
  it.each<[MarketResult & { op: "error" }, string, string]>([
    [{ op: "error", code: "signed_out", message: "" }, "needs-human", "signed_out"],
    [
      { op: "error", code: "reauth", message: "Sign in again to do this." },
      "needs-human",
      "reauth",
    ],
    [
      {
        op: "error",
        code: "person_only",
        message: "Withdrawing is yours to do.",
        request: "int_1",
      },
      "needs-human",
      "person_only",
    ],
    [
      { op: "error", code: "suspended", message: "Your publisher is suspended." },
      "refused",
      "suspended",
    ],
    [{ op: "error", code: "quota", message: "Ten versions a day." }, "refused", "quota"],
    [{ op: "error", code: "forbidden", message: "Not yours." }, "refused", "forbidden"],
    [{ op: "error", code: "conflict", message: "Taken." }, "refused", "conflict"],
    [{ op: "error", code: "blocked", message: "The scan blocked it." }, "failed", "blocked"],
  ])("%j exits as %s with code %s", (error, outcome, code) => {
    const failure = marketFailure(error);
    expect(failure.outcome).toBe(outcome);
    expect(failure.detail.code).toBe(code);
  });

  it("signed out says to sign in, with ace login as the next step", () => {
    const failure = marketFailure({ op: "error", code: "signed_out", message: "no account" });
    expect(failure.message).toBe("Sign in to publish.");
    expect(failure.detail.hint).toContain("ace login");
  });

  it("a market grant that couldn't be minted is a refusal to retry, not a turned-off marketplace", () => {
    const failure = marketFailure({
      op: "error",
      code: "unavailable",
      message: "ace's account service can't give a market grant: The operation timed out.",
    });
    expect(failure.outcome).toBe("refused");
    expect(failure.detail.code).toBe("refused");
    expect(failure.detail.hint).toContain("ace account status");
    expect(failure.detail.hint).not.toContain("features on marketplace");
  });

  it("a marketplace turned off in Settings › Beta says how to turn it on", () => {
    const failure = marketFailure({
      op: "error",
      code: "unavailable",
      message: "The marketplace is turned off. Turn it on in Settings › Beta.",
    });
    expect(failure.detail.code).toBe("turned_off");
    expect(failure.detail.hint).toBe("Turn the marketplace on with ace features on marketplace.");
  });

  it("a person-only answer carries the request ace opened", () => {
    const failure = marketFailure({
      op: "error",
      code: "person_only",
      message: "x",
      request: "int_7",
    });
    expect(failure.detail.request).toBe("int_7");
  });
});

describe("install shows the review before anything changes", () => {
  const review: MarketReview = {
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
    body: { type: "suit", passes: true, problems: [], scenes: [], fonts: [], files: 3 },
    expiresAt: 0,
    items: 0,
  };
  function daemon(answer: MarketReview = review) {
    const sent: MarketOperation[] = [];
    const ask = async (operation: MarketOperation): Promise<MarketAnswer> => {
      sent.push(operation);
      if (operation.op === "prepare") return { op: "review", review: answer };
      if (operation.op === "readReview") return { op: "reviewPage", review: answer, items: [] };
      if (operation.op === "install") return { op: "done", installed };
      return { op: "done" };
    };
    return { sent, ask };
  }
  const prepare: MarketOperation = {
    op: "prepare",
    source: "market",
    type: "suit",
    name: "dusk-harbor",
  };

  it("--yes installs the reviewed hash with no routines started, after the review on stderr", async () => {
    const world = daemon();
    const written: string[] = [];
    const done = await installReviewed(world.ask, prepare, { kind: "yes" }, (text) =>
      written.push(text),
    );
    expect(done.installed).toEqual(installed);
    expect(world.sent.at(-1)).toEqual({
      op: "install",
      id: "rv-1",
      hash,
      choices: { bots: [], needs: {}, startRoutines: false },
    });
    expect(written.join("")).toContain("suit/dusk-harbor 1.2.0: Dusk Harbor");
  });

  it("without a terminal or --yes it installs nothing and exits 2 with the review", async () => {
    const world = daemon();
    const failure = await installReviewed(world.ask, prepare, { kind: "none" }, () => {}).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ outcome: "needs-human", detail: { code: "confirm" } });
    expect(failure).toHaveProperty("evidence.review.id", "rv-1");
    expect(world.sent.some((operation) => operation.op === "install")).toBe(false);
    expect(world.sent.at(-1)).toEqual({ op: "cancel", id: "rv-1" });
  });

  it("a blocked review exits 4 with its sentence, even with --yes", async () => {
    const world = daemon({ ...review, blocked: "This Suit fails ace's checks." });
    const failure = await installReviewed(world.ask, prepare, { kind: "yes" }, () => {}).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ outcome: "refused", message: "This Suit fails ace's checks." });
    expect(world.sent.some((operation) => operation.op === "install")).toBe(false);
  });
});
