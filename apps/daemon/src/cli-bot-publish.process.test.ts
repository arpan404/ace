import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { contentHash, hashFiles, readArchive, typeLimits } from "@ace/marketplace";
import type { MarketDraft, MarketMe } from "@ace/protocol/marketplace";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
import { hostConnection } from "./cli/connection.ts";
import { accessRequest } from "./client-access.ts";
import { fakeMarket } from "./marketplace/test-support.ts";

/*
 * `ace bot publish` (ADR 0200 §9) against a real daemon signed in to a fake ace account, beside a
 * market on this machine: the package is checked and its scenarios run first, and only then is
 * it uploaded through `ace market publish spade-bot`'s own path. Never the real market.
 */

const spade = fileURLToPath(new URL("../../../spade/target/debug/spade", import.meta.url));
const haveSpade = existsSync(spade) || process.env.CI === "true";

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

async function world() {
  const backend = await startFakeAccountBackend(() => Date.now());
  cleanup.push(() => backend.close());
  const market = await fakeMarket();
  cleanup.push(() => market.close());
  const uploads: { hash: string; paths: string[] }[] = [];
  market.route((seen, _response, answer) => {
    if (seen.method === "GET" && seen.path === "/v1/me") answer(200, me);
    else if (seen.method === "POST" && seen.path.startsWith("/v1/me/drafts?")) {
      const files = readArchive(new Uint8Array(seen.body), typeLimits["spade-bot"]);
      const hash = contentHash(hashFiles(files));
      uploads.push({ hash, paths: files.map((file) => file.path).toSorted() });
      const draft: MarketDraft = {
        id: "drf_farebots",
        type: "spade-bot",
        name: "fare-watcher",
        version: "1.0.0",
        hash,
        size: 100,
        files: files.length,
        created: 1,
        updated: 1,
        changelog: "",
        title: "Fare watcher",
        problems: [],
        scan: { state: "scanning", read: 0, files: files.length },
      };
      answer(201, draft);
    } else return false;
    return true;
  });
  const f = await daemonFixture(
    undefined,
    {},
    { ACE_MARKET_URL: market.origin, ACE_ACCOUNT_URL: backend.origin },
  );
  cleanup.push(() => f.daemon.close());
  await f.daemon.settings.set("beta.marketplace", true, { kind: "global" });
  await f.daemon.settings.set("remote.enabled", false, { kind: "global" });
  const home = join(f.h.home, "daemon");
  const { origin, token } = hostConnection(home);
  await accessRequest(origin, "/v1/ace-account", {
    method: "PUT",
    token,
    body: { origin: backend.origin, token: backend.token },
  });
  const root = await mkdtemp(join(tmpdir(), "ace-bot-publish-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  const cli = (args: string[]) =>
    invoke(home, args, "", {
      HOME: join(root, "home"),
      ACE_SPADE_BIN: spade,
      ACE_THREAD_ID: "",
      ACE_NO_INPUT: "",
      // Where `ace bot publish` reads the published version it compares contracts with.
      ACE_MARKET_URL: market.origin,
    });
  return { market, uploads, root, cli };
}

async function fareWatcher(root: string, reply: string) {
  const folder = join(root, "fare-watcher");
  await mkdir(join(folder, "tests"), { recursive: true });
  await writeFile(
    join(folder, "bot.json"),
    JSON.stringify({
      format: "spade-bot",
      version: 3,
      requires: { runtime: "1" },
      name: "Fare watcher",
      blurb: "Watches fares.",
      task: "You watch fares for the person.",
      model: "fast",
      triggers: [{ kind: "message" }],
      tests: ["tests/hello.json"],
      pricing: { kind: "free" },
    }),
  );
  await writeFile(
    join(folder, "tests/hello.json"),
    JSON.stringify({
      name: "Says hello",
      given: { message: "Hi" },
      model: [{ say: reply }],
      expect: { reply_contains: ["hello"] },
    }),
  );
  return folder;
}

test.skipIf(!haveSpade)(
  "publish checks and tests the package, then uploads it as a spade-bot draft",
  async () => {
    const { uploads, root, cli } = await world();
    const folder = await fareWatcher(root, "Hello there.");
    const checked = await cli(["bot", "check", folder, "--json"]);
    expect(checked.code, checked.stderr).toBe(0);
    const published = await cli([
      "bot",
      "publish",
      folder,
      "--version",
      "1.0.0",
      "--draft",
      "--json",
    ]);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({
      kind: "draft",
      draft: { id: "drf_farebots", type: "spade-bot", name: "fare-watcher" },
    });
    // The bytes the market got are the package `ace bot check` read.
    expect(uploads).toEqual([
      { hash: JSON.parse(checked.stdout).hash, paths: ["bot.json", "tests/hello.json"] },
    ]);
  },
  30_000,
);

test.skipIf(!haveSpade)(
  "a package whose scenario fails is never uploaded",
  async () => {
    const { market, uploads, root, cli } = await world();
    const folder = await fareWatcher(root, "Goodbye.");
    const published = await cli(["bot", "publish", folder, "--version", "1.0.0", "--json"]);
    expect(published.code).toBe(1);
    expect(JSON.parse(published.stdout)).toMatchObject({
      code: "check_failed",
      problems: [
        { path: "tests/hello.json", message: 'Says hello: The reply doesn\'t say "hello"' },
      ],
    });
    expect(uploads).toEqual([]);
    expect(market.seen.some((seen) => seen.path.startsWith("/v1/me/drafts"))).toBe(false);
  },
  30_000,
);
