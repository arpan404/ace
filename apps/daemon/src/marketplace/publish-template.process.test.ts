import { afterEach, beforeEach, expect, test } from "vitest";
import { contentHash, hashFiles, readArchive, typeLimits } from "@ace/marketplace";
import { signedVersion } from "@ace/marketplace/testing";
import type {
  MarketDraft,
  MarketMe,
  MarketOperation,
  ShareTemplateDraft,
} from "@ace/protocol/marketplace";
import type { TemplateBinding } from "./publish-template.ts";
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
let receipt: TemplateBinding | undefined;
let candidate: ShareTemplateDraft | undefined;
let loseReply: boolean;
let skillFile: string;
const standing = {
  withoutPerson: false,
  names: ["Ada Example", "ada@example.test"],
  grant: async () => "test-market-grant",
};
const versionPath = "/v1/me/drafts/drf_abcdefgh/publish";

beforeEach(async () => {
  market = await fakeMarket();
  spade = await fakeSpade();
  receipt = undefined;
  candidate = undefined;
  loseReply = false;
  skillFile = "Capture cold and warm timings.";
  harness = await marketplaceHarness({
    origin: market.origin,
    spade,
    templates: {
      authorize: async (_id, review) => ({
        bot: "a_local",
        surface_files: [],
        skills: [
          {
            reference: "skills/measure",
            text: "---\nname: measure\ndescription: Measure rendering performance.\n---\nUse the procedure in baseline.md.",
            files: [{ path: "baseline.md", text: skillFile, executable: false }],
          },
        ],
        left_out: ["Conversation history stays here."],
        recipe: {
          format: "spade-bot",
          version: 3,
          name: review.name,
          blurb: review.description,
          model: "capable",
          task: review.task,
          notes: review.notes,
          ...(review.knowledge ? { knowledge: review.knowledge } : {}),
          skills: ["skills/measure"],
          requires: { runtime: "1" },
          pricing: { kind: "free" },
          triggers: [{ kind: "message" }],
          needs: { connectors: [] },
        },
      }),
      begin: async (_id, _review, draft) => {
        candidate = draft;
      },
      published: async (_id, binding) => {
        receipt = binding;
      },
    },
  });
  const me: MarketMe = {
    profile: {
      id: "pub_test",
      handle: "tester",
      displayName: "Test publisher",
      bio: "",
      links: [],
      joined: 1,
      verified: false,
      proofs: [],
      pins: [],
    },
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
  let saved: { hash: string; visibility: string } | undefined;
  market.route((call, _response, answer) => {
    const url = new URL(call.path, "https://example.test");
    if (call.path === "/v1/me") {
      answer(200, me);
    } else if (call.path === `/v1/me/entries/${type}/${name}`) {
      if (!saved) answer(404, { error: "not_found" });
      else
        answer(200, {
          summary: {
            type,
            name,
            title: "Render benchmarks",
            line: "",
            visibility: saved.visibility,
            archived: false,
            pinned: false,
            reviewed: false,
            versions: 1,
            downloads: 0,
            pendingListing: false,
            openReports: 0,
          },
          listing: {
            title: "Render benchmarks",
            line: "",
            description: "",
            categories: [],
            keywords: [],
            links: [],
            previews: [],
          },
          versions: [
            {
              version,
              hash: saved.hash,
              size: 1,
              published: 1,
              status: "waiting",
              held: false,
              changelog: "",
              downloads: 0,
            },
          ],
        });
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
      if (call.authorization !== "Bearer test-person-grant") {
        answer(403, { error: "forbidden" });
      } else if (url.searchParams.get("reviewed") !== signed.hash) {
        answer(409, { error: "conflict" });
      } else {
        const visibility = url.searchParams.get("visibility") ?? "";
        market.publish(signed, staged, visibility);
        saved = { hash: signed.hash, visibility };
        if (loseReply) answer(503, { error: "unavailable" });
        else answer(201, { status: "pending", ...key, ...saved });
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
    reviewed: true,
    visibility,
    name: "Render benchmarks",
    description: "Measure rendering speed.",
    task: "Measure a baseline.",
    notes: ["Compare medians."],
    knowledge: [
      {
        kind: "lesson",
        title: "Calibrate",
        topic: "rendering",
        body: "Compare runs at one resolution.",
      },
    ],
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

test("the signed-in person's name is refused before a reviewed draft uploads", async () => {
  const request = operation("listed");
  if (request.op !== "publishTemplate") throw new Error("Expected a template publication.");
  request.review.knowledge = [
    {
      kind: "lesson",
      title: "Calibrate",
      topic: "rendering",
      body: "Send the summary to Ada Example.",
    },
  ];
  expect(await harness.service.request(request, standing)).toMatchObject({
    op: "error",
    code: "invalid",
  });
  expect(market.seen).toEqual([]);
});

test("the final scan requires identity and refuses personal text in a retained skill file", async () => {
  const request = operation("listed");
  expect(await harness.service.request(request, { ...standing, names: [] })).toMatchObject({
    op: "error",
    code: "signed_out",
  });
  skillFile = "Send the timings to Ada Example.";
  expect(await harness.service.request(request, standing)).toMatchObject({
    op: "error",
    code: "invalid",
  });
  expect(candidate).toBeUndefined();
  expect(market.seen).toEqual([]);
});

test.each(["listed", "unlisted"] as const)(
  "a person creates a %s listing and the signed link follows install review",
  async (visibility) => {
    expect(await harness.service.request(operation(visibility), standing)).toMatchObject({
      op: "templateGrant",
      target: { name, visibility },
    });
    expect(
      await harness.service.request(operation(visibility), {
        ...standing,
        personGrant: "test-person-grant",
      }),
    ).toEqual({ op: "publishedTemplate", name, visibility });
    const uploaded = market.seen.find(
      ({ method, path }) => method === "POST" && path.startsWith("/v1/me/drafts?"),
    );
    if (!uploaded) throw new Error("Expected the template archive.");
    const archive = readArchive(new Uint8Array(uploaded.body), typeLimits[type]);
    expect(archive.map(({ path }) => path)).toContain("skills/measure/baseline.md");
    expect(candidate?.recipe.notes).toEqual(["Compare medians."]);
    expect(candidate?.recipe.knowledge).toEqual([
      {
        kind: "lesson",
        title: "Calibrate",
        topic: "rendering",
        body: "Compare runs at one resolution.",
      },
    ]);
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
        recipe: expect.objectContaining({
          notes: ["Compare medians."],
          version: 3,
          knowledge: [expect.objectContaining({ title: "Calibrate", kind: "lesson" })],
        }),
      }),
    );
  },
);

test("a lost Store reply is reconciled from the stored hash and visibility after restart", async () => {
  const request = operation("unlisted");
  loseReply = true;
  expect(
    await harness.service.request(request, {
      ...standing,
      personGrant: "test-person-grant",
    }),
  ).toMatchObject({ op: "error" });
  expect(receipt).toBeUndefined();
  await harness.restart();
  expect(await harness.service.request(request, standing)).toEqual({
    op: "publishedTemplate",
    name,
    visibility: "unlisted",
  });
  expect(receipt).toMatchObject({ visibility: "unlisted" });
  expect(market.seen.filter(({ path }) => path.startsWith(versionPath))).toHaveLength(1);
});
