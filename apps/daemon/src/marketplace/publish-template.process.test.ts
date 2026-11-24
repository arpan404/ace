import { afterEach, beforeEach, expect, test } from "vitest";
import { contentHash, hashFiles, readArchive, typeLimits } from "@ace/marketplace";
import { signedVersion } from "@ace/marketplace/testing";
import type {
  MarketDraft,
  MarketMe,
  MarketOperation,
  ShareTemplateDraft,
} from "@ace/protocol/marketplace";
import { MarketAgent } from "./market-agent.ts";
import { Store } from "../store.ts";
import { join } from "node:path";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./test-support.ts";

const id = `template_${"a".repeat(32)}`;
const name = id.replaceAll("_", "-");
const type = "spade-bot";
const version = "1.0.0";
const key = { type, name, version } as const;

let market: Awaited<ReturnType<typeof fakeMarket>>;
let spade: Awaited<ReturnType<typeof fakeSpade>>;
let harness: Awaited<ReturnType<typeof marketplaceHarness>>;
let receipt: ShareTemplateDraft | undefined;
const versionPath = "/v1/me/drafts/drf_abcdefgh/publish";

beforeEach(async () => {
  market = await fakeMarket();
  spade = await fakeSpade();
  receipt = undefined;
  harness = await marketplaceHarness({
    origin: market.origin,
    spade,
    templates: {
      authorize: async (_id, review) => ({
        bot: "a_local",
        skills: [],
        left_out: ["Conversation history stays here."],
        recipe: {
          format: "spade-bot",
          version: 3,
          name: review.name,
          blurb: review.description,
          model: "capable",
          task: review.task,
          notes: review.notes,
          skills: [],
          requires: { runtime: "1" },
          pricing: { kind: "free" },
          triggers: [{ kind: "message" }],
          needs: { connectors: [] },
        },
      }),
      published: async (_id, _review, draft) => {
        receipt = draft;
      },
    },
  });
  const me: MarketMe = {
    state: "active",
    newPublisher: false,
    limits: {
      uploadsToday: 0,
      uploadsPerDay: 10,
      storedBytes: 0,
      quotaBytes: 1_000_000,
      drafts: 0,
      draftLimit: 20,
    },
    drafts: [],
    transfers: [],
    entries: [],
  };
  let staged: ReturnType<typeof readArchive> | undefined;
  market.route((call, _response, answer) => {
    const url = new URL(call.path, "https://example.test");
    if (call.path === "/v1/me") {
      answer(200, me);
    } else if (call.method === "POST" && url.pathname === "/v1/me/drafts") {
      staged = readArchive(new Uint8Array(call.body), typeLimits[type]);
      const hash = contentHash(hashFiles(staged));
      const draft: MarketDraft = {
        ...key,
        id: "drf_abcdefgh",
        hash,
        size: call.body.byteLength,
        files: staged.length,
        created: 1,
        updated: 1,
        title: "Render benchmarks",
        changelog: "",
        problems: [],
        scan: {
          state: "done",
          report: {
            format: "ace-market-scan",
            hash,
            runnable: false,
            scanner: 1,
            verdict: "pass",
            checks: [],
            findings: [],
            truncated: false,
            read: { files: 1, textBytes: 100 },
          },
        },
      };
      answer(201, draft);
    } else if (call.method === "POST" && url.pathname === versionPath && staged) {
      const signed = signedVersion({ ...key, files: staged });
      if (url.searchParams.get("reviewed") !== signed.hash) {
        answer(409, { error: "conflict" });
      } else {
        market.publish(signed, staged, url.searchParams.get("visibility") ?? undefined);
        answer(201, { status: "pending", ...key, hash: signed.hash });
      }
    } else return false;
    return true;
  });
});

afterEach(async () => {
  await harness.close();
  await market.close();
  await spade.close();
});

const operation = (visibility: "listed" | "unlisted"): MarketOperation => ({
  op: "publishTemplate",
  id,
  review: {
    revision: "a".repeat(64),
    visibility,
    name: "Render benchmarks",
    description: "Measure rendering speed.",
    task: "Measure a baseline.",
    notes: ["Compare medians."],
    routines: [],
    skills: [],
    connectors: [],
  },
});

test("an agent and an unproven caller cannot publish a template", async () => {
  const store = new Store(join(harness.root, "test.sqlite"));
  try {
    const agent = new MarketAgent({
      marketplace: harness.service,
      store,
      engine: () => undefined,
      settings: () => undefined,
      id: () => "id",
    });
    expect(await agent.forAgent("thread-agent", operation("listed"))).toMatchObject({
      op: "error",
      code: "forbidden",
    });
    expect(await harness.service.request(operation("listed"))).toMatchObject({
      op: "error",
      code: "forbidden",
    });
    expect(market.seen).toEqual([]);
  } finally {
    store.close();
  }
});

test.each(["listed", "unlisted"] as const)(
  "a person creates a %s listing and the signed link follows install review",
  async (visibility) => {
    expect(
      await harness.service.request(operation(visibility), {
        withoutPerson: false,
        grant: async () => "test-market-grant",
      }),
    ).toEqual({ op: "publishedTemplate", name, visibility });
    expect(receipt?.recipe.notes).toEqual(["Compare medians."]);
    await harness.ask({ op: "refresh" }, "sources");
    const search = await harness.ask(
      { op: "search", query: "Render", limit: 20, offset: 0 },
      "search",
    );
    expect(search.entries.some((entry) => entry.name === name)).toBe(visibility === "listed");
    const listing = await harness.ask({ op: "read", source: "market", type, name }, "read");
    expect(listing.entry.summary.title).toBe("Render benchmarks");
    const { review } = await harness.ask({ op: "prepare", source: "market", type, name }, "review");
    expect(review.unlisted === true).toBe(visibility === "unlisted");
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    expect(spade.made).toContainEqual(
      expect.objectContaining({
        recipe: expect.objectContaining({ notes: ["Compare medians."], version: 3 }),
      }),
    );
  },
);
