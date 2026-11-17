import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { contentHash, hashFiles, readArchive, typeLimits } from "@ace/marketplace";
import type { MarketDraft, MarketMe } from "@ace/protocol/marketplace";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
import { hostConnection } from "./cli/connection.ts";
import { accessRequest } from "./client-access.ts";
import { fakeMarket } from "./marketplace/test-support.ts";

/*
 * `ace market` against a real daemon, a fake market and a fake ace account (ADR 0176 §12):
 * a publisher's draft reaches the market with this machine's grant, and an agent's shell
 * (ACE_THREAD_ID) asking to withdraw gets the person's request instead, whatever --yes says.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

const me: MarketMe = {
  state: "active",
  newPublisher: true,
  limits: {
    uploadsToday: 0,
    uploadsPerDay: 10,
    storedBytes: 0,
    quotaBytes: 256 * 1024 * 1024,
    drafts: 0,
    draftLimit: 20,
  },
  entries: [],
  drafts: [],
  transfers: [],
};
const draft = (hash: string): MarketDraft => ({
  id: "drf_abcdefgh",
  type: "spade-skill",
  name: "triage-mail",
  version: "1.0.0",
  hash,
  size: 100,
  files: 1,
  created: 1,
  updated: 1,
  changelog: "",
  title: "Triage mail",
  problems: [],
  scan: { state: "scanning", read: 0, files: 1 },
});

/** A daemon with the marketplace on, signed in to a fake ace account, beside a fake market. */
async function world() {
  const backend = await startFakeAccountBackend(() => Date.now());
  cleanup.push(() => backend.close());
  const market = await fakeMarket();
  cleanup.push(() => market.close());
  market.route((seen, _response, answer) => {
    if (seen.method === "GET" && seen.path === "/v1/me") answer(200, me);
    else if (seen.method === "POST" && seen.path.startsWith("/v1/me/drafts?")) {
      const files = readArchive(new Uint8Array(seen.body), typeLimits["spade-skill"]);
      answer(201, draft(contentHash(hashFiles(files))));
    } else if (seen.method === "POST" && seen.path.endsWith("/withdraw"))
      answer(202, { status: "pending", versions: ["1.0.0"] });
    else return false;
    return true;
  });
  const f = await daemonFixture(
    undefined,
    {},
    {
      ACE_MARKET_URL: market.origin,
      ACE_ACCOUNT_URL: backend.origin,
    },
  );
  cleanup.push(() => f.daemon.close());
  await f.daemon.settings.set("beta.marketplace", true, { kind: "global" });
  // Signing in starts ace's relay registration, which this fake account doesn't serve; remote
  // access isn't what these tests are about, and left on it holds the daemon's shutdown.
  await f.daemon.settings.set("remote.enabled", false, { kind: "global" });
  const home = join(f.h.home, "daemon");
  const { origin, token } = hostConnection(home);
  await accessRequest(origin, "/v1/ace-account", {
    method: "PUT",
    token,
    body: { origin: backend.origin, token: backend.token },
  });
  const root = await mkdtemp(join(tmpdir(), "ace-cli-market-agent-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // The CLI never reads the person's own home.
  const emptyHome = join(root, "home");
  await mkdir(emptyHome);
  const skill = join(root, "triage-mail");
  await mkdir(skill);
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: triage-mail\ndescription: Sorts mail.\n---\n# Triage\n",
  );
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    invoke(home, args, "", { HOME: emptyHome, ACE_NO_INPUT: "1", ...env });
  return { f, market, skill, cli };
}

test("market publish --draft uploads the folder with this machine's grant and prints the draft", async () => {
  const { market, skill, cli } = await world();
  const published = await cli([
    "market",
    "publish",
    "spade-skill",
    skill,
    "--version",
    "1.0.0",
    "--draft",
    "--json",
  ]);
  expect(published.code, published.stderr).toBe(0);
  expect(JSON.parse(published.stdout)).toMatchObject({
    kind: "draft",
    draft: { id: "drf_abcdefgh", type: "spade-skill", name: "triage-mail", version: "1.0.0" },
  });
  const upload = market.seen.find(
    (seen) => seen.method === "POST" && seen.path.startsWith("/v1/me/drafts?"),
  );
  expect(upload?.authorization).toMatch(/^Bearer .+/);
  // --draft stops at the draft: nothing was published.
  expect(market.seen.some((seen) => seen.path.endsWith("/publish"))).toBe(false);
});

test("market withdraw from an agent's shell exits 2 with the person's request, even with --yes", async () => {
  const { f, market, cli } = await world();
  const thread = f.caller.threadId;
  for (const yes of [[], ["--yes"]]) {
    const asked = await cli(
      [
        "market",
        "withdraw",
        "spade-skill/triage-mail@1.0.0",
        "--reason",
        "Broken",
        "--json",
        ...yes,
      ],
      { ACE_THREAD_ID: thread },
    );
    expect(asked.code, asked.stderr).toBe(2);
    const error = z
      .object({ code: z.literal("person_only"), request: z.string().min(1) })
      .loose()
      .parse(JSON.parse(asked.stdout));
    const interaction = f.daemon.store.getInteraction(error.request);
    expect(interaction).toMatchObject({ threadId: thread, state: "pending" });
  }
  expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(false);
});

test("the same withdrawal from the person's own terminal goes to the market", async () => {
  const { market, cli } = await world();
  const withdrawn = await cli([
    "market",
    "withdraw",
    "spade-skill/triage-mail@1.0.0",
    "--reason",
    "Broken",
    "--json",
  ]);
  expect(withdrawn.code, withdrawn.stderr).toBe(0);
  expect(JSON.parse(withdrawn.stdout)).toEqual({ kind: "pending", what: "withdrawal" });
  expect(market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(true);
});
