import { expect, test } from "vitest";
import type { MarketOperation, MarketPublishAction, MarketResult } from "@ace/protocol/marketplace";
import { MarketResult as MarketResultSchema } from "@ace/protocol/marketplace";
import { marketPublishFixture } from "./marketplace-publish-fixture.ts";
import { FakeMarketplaceWire } from "./marketplace-wire.ts";

/* The fake daemon's publishing, Discover and publisher pages (ADR 0173), from seeded state. */

function wire(signedOut = false) {
  const fake = new FakeMarketplaceWire(() => 5_000);
  fake.seed({ publishing: marketPublishFixture({ signedOut }) });
  let n = 0;
  const ask = (operation: MarketOperation): MarketResult => {
    const message = fake.handle({ type: "marketplace.request", requestId: `r${++n}`, operation });
    if (message.type !== "marketplace.result") throw new Error("no result");
    // Every answer is one the app's schema reads.
    return MarketResultSchema.parse(message.result);
  };
  const publish = (request: MarketPublishAction) => ask({ op: "publish", request });
  return { fake, ask, publish };
}

test("every publish answers signed_out when seeded signed out", () => {
  const { publish } = wire(true);
  expect(publish({ action: "me" })).toEqual({
    op: "error",
    code: "signed_out",
    message: "Sign in to publish.",
  });
});

test("the publisher's page lists the seeded entries with their version statuses", () => {
  const { publish } = wire();
  const result = publish({ action: "me" });
  if (result.op !== "publish" || result.answer.kind !== "me") throw new Error("not me");
  const { me } = result.answer;
  expect(me.profile?.handle).toBe("harbour");
  expect(me.entries.map((entry) => [entry.name, entry.status])).toEqual([
    ["harbour-dusk", "live"],
    ["mail-tools", "waiting"],
    ["setup-mail", "blocked"],
    ["old-sorter", "withdrawn"],
  ]);
  expect(me.transfers[0]?.direction).toBe("incoming");
});

test("a new draft scans, is done on the next read, and then publishes as waiting", () => {
  const { publish } = wire();
  const created = publish({
    action: "draftCreate",
    type: "spade-skill",
    name: "inbox-zero",
    version: "1.0.0",
    source: { kind: "archive", archive: "" },
  });
  if (created.op !== "publish" || created.answer.kind !== "draft") throw new Error("no draft");
  const { id } = created.answer.draft;
  expect(created.answer.draft.scan.state).toBe("scanning");
  expect(publish({ action: "draftPublish", id })).toMatchObject({ code: "conflict" });
  expect(publish({ action: "draftRead", id })).toMatchObject({
    answer: { draft: { scan: { state: "done", report: { verdict: "pass" } } } },
  });
  expect(publish({ action: "draftPublish", id })).toEqual({
    op: "publish",
    answer: {
      kind: "published",
      type: "spade-skill",
      name: "inbox-zero",
      version: "1.0.0",
      held: false,
    },
  });
  expect(publish({ action: "entry", type: "spade-skill", name: "inbox-zero" })).toMatchObject({
    answer: { entry: { summary: { status: "waiting" } } },
  });
});

test("seeded drafts publish held, or are blocked with the scan's findings", () => {
  const { publish } = wire();
  expect(publish({ action: "draftPublish", id: "drf_heldnext" })).toMatchObject({
    answer: { kind: "published", held: true },
  });
  expect(publish({ action: "draftPublish", id: "drf_blockednext" })).toMatchObject({
    op: "error",
    code: "blocked",
    scan: { verdict: "block", findings: [{ rule: "download-exec" }] },
  });
});

test("managing an entry changes what its page answers", () => {
  const { publish } = wire();
  const entry = { type: "suit" as const, name: "harbour-dusk" };
  publish({ action: "deprecate", ...entry, version: "1.2.0", note: "Use 2.0." });
  publish({ action: "visibility", ...entry, visibility: "unlisted" });
  const result = publish({
    action: "withdraw",
    ...entry,
    version: "1.1.0",
    reason: "Contrast bug",
  });
  expect(result).toMatchObject({
    answer: {
      kind: "entry",
      entry: {
        summary: { visibility: "unlisted" },
        versions: [
          { version: "1.2.0", deprecated: "Use 2.0." },
          { version: "1.1.0", status: "withdrawn", reason: "Contrast bug" },
        ],
      },
    },
  });
  expect(publish({ action: "signals", ...entry })).toMatchObject({
    answer: { kind: "signals", signals: { adoption: { latest: "1.2.0" } } },
  });
  expect(publish({ action: "entry", type: "suit", name: "not-mine" })).toMatchObject({
    code: "not_found",
  });
});

test("Discover, publisher pages and reports answer from the seed", () => {
  const { ask, fake } = wire();
  const discover = ask({ op: "discover" });
  if (discover.op !== "discover") throw new Error("no discover");
  expect(discover.discover.trending.map((row) => row.entry.name)).toEqual([
    "triage-mail",
    "harbour-dusk",
  ]);
  expect(discover.discover.readAt).toBe(5_000);
  expect(ask({ op: "publisher", handle: "lighthouse" })).toMatchObject({
    page: { profile: { handle: "lighthouse", verified: false } },
  });
  expect(ask({ op: "publisher", handle: "nobody" })).toMatchObject({ code: "not_found" });
  expect(
    ask({ op: "report", type: "suit", name: "night-ferry", reason: "spam", note: "" }),
  ).toEqual({ op: "done" });
  expect(fake.publishing.reports).toHaveLength(1);
});

test("verification moves from applied to passed proofs", () => {
  const { publish } = wire();
  expect(publish({ action: "applyVerification", domain: "harbour.example" })).toMatchObject({
    answer: {
      verification: { state: "applied", challenges: [{ kind: "domain", state: "waiting" }] },
    },
  });
  expect(publish({ action: "checkVerification" })).toMatchObject({
    answer: { verification: { challenges: [{ state: "passed" }] } },
  });
});
