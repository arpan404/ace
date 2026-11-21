import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { encodeBase64url, grantPublicKey } from "@ace/account-grant";
import { verifyManifest, writeArchive } from "@ace/marketplace";
import { folder as filesOf, keySetOf } from "@ace/marketplace/testing";
import { marketGrant, marketKey, signerToken, startMarketWorker } from "@ace/market/testing";
import { MarketOwnEntry, VersionBody } from "@ace/protocol/marketplace";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { hostConnection } from "./cli/connection.ts";
import { accessRequest } from "./client-access.ts";

/*
 * `ace bot publish` (ADR 0200 §9) end to end against the real market Worker (Miniflare), not the
 * daemon's fake: a daemon signed in to a local account backend publishes the package, a
 * maintainer releases it, and `ace market maintainer sign` runs the package's own tests on
 * Spade's program before it signs (ADR 0200 §8). What it signs verifies with the market's key; a
 * package whose tests fail on the signer is refused, and the publisher reads why. Never the real
 * market, never a real model: the scenarios run on spade-testkit's scripted model.
 */

const spade = fileURLToPath(new URL("../../../spade/target/debug/spade", import.meta.url));
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

/**
 * The CLI in its own process on Node, as release builds run it: Node strips its TypeScript, so a
 * module Node can't load fails here (this suite runs on Node).
 */
function invoke(home: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { env: { ...process.env, ...env, ACE_HOME: home }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}
const haveSpade = existsSync(spade) || process.env.CI === "true";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

async function world() {
  const backend = await startFakeAccountBackend(() => Date.now());
  cleanup.push(() => backend.close());
  const market = await startMarketWorker({ grantKeys: [grantPublicKey(backend.signingKey)] });
  cleanup.push(() => market.close());
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
  const root = await mkdtemp(join(tmpdir(), "ace-bot-publish-market-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  const keyFile = join(root, "market.key");
  await writeFile(
    keyFile,
    JSON.stringify({ id: marketKey.id, privateKey: encodeBase64url(marketKey.privateKey) }),
    { mode: 0o600 },
  );
  const env = {
    HOME: join(root, "home"),
    ACE_SPADE_BIN: spade,
    ACE_THREAD_ID: "",
    ACE_NO_INPUT: "",
    ACE_MARKET_SIGNER_TOKEN: signerToken,
    // Where `ace bot publish` reads the published version it compares contracts with.
    ACE_MARKET_URL: market.origin,
  };
  const cli = (args: string[]) => invoke(home, args, env);
  /** A maintainer's `ace market maintainer VERB …` against this Worker. */
  const maintainer = (args: string[]) =>
    cli(["market", "maintainer", ...args, "--dev-market", market.origin]);
  return { market, root, cli, maintainer, keyFile };
}

/** A bot package whose one scenario expects a reply saying hello; `reply` is the model's. */
function fareWatcher(reply: string) {
  return {
    "bot.json": JSON.stringify({
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
    "tests/hello.json": JSON.stringify({
      name: "Says hello",
      given: { message: "Hi" },
      model: [{ say: reply }],
      expect: { reply_contains: ["hello"] },
    }),
  };
}

async function write(root: string, name: string, files: Record<string, string>) {
  const folder = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  return folder;
}

test.skipIf(!haveSpade)(
  "a package ace bot publish uploads to the real market is signed after the signer runs its tests",
  async () => {
    const { market, root, cli, maintainer, keyFile } = await world();
    const folder = await write(root, "fare-watcher", fareWatcher("Hello there."));
    const profile = await cli([
      "market",
      "profile",
      "create",
      "--handle",
      "farefolk",
      "--name",
      "Fare folk",
      "--json",
    ]);
    expect(profile.code, profile.stdout + profile.stderr).toBe(0);
    const checked = await cli(["bot", "check", folder, "--json"]);
    expect(checked.code, checked.stderr).toBe(0);
    const published = await cli([
      "bot",
      "publish",
      folder,
      "--version",
      "1.0.0",
      "--yes",
      "--json",
    ]);
    expect(published.code, published.stdout + published.stderr).toBe(0);

    // A new publisher's first version waits for a maintainer, who releases it.
    const released = await maintainer(["review", "spade-bot/fare-watcher@1.0.0", "--approve"]);
    expect(released.code, released.stdout + released.stderr).toBe(0);
    const signing = await maintainer(["sign", "--key", keyFile, "--json"]);
    expect(signing.code, signing.stdout + signing.stderr).toBe(0);
    expect(JSON.parse(signing.stdout)).toMatchObject({
      signed: ["spade-bot/fare-watcher@1.0.0"],
      tested: [{ version: "spade-bot/fare-watcher@1.0.0", scenarios: 1 }],
    });

    // Listed, signed by the market's key over the bytes `ace bot check` read.
    const answer = await market.fetch("/v1/entries/spade-bot/fare-watcher/1.0.0");
    expect(answer.status).toBe(200);
    const body = VersionBody.parse(await answer.json());
    const manifest = verifyManifest(body.manifest, keySetOf(marketKey));
    expect(manifest.hash).toBe(JSON.parse(checked.stdout).hash);
  },
  120_000,
);

test.skipIf(!haveSpade)(
  "a package whose tests fail on the signer is refused there, and the publisher reads why",
  async () => {
    const { market, maintainer, keyFile } = await world();
    // Uploaded past `ace bot publish`'s own run, as any client could: the signer still runs it.
    const files = filesOf(fareWatcher("Goodbye."));
    const grant = marketGrant("acct_a");
    const uploaded = await market.fetch(
      "/v1/publish/spade-bot/fare-watcher/versions?version=1.0.0&publisher=tester",
      {
        method: "POST",
        headers: { authorization: `Bearer ${grant}`, "content-type": "application/x-tar" },
        body: new Blob([new Uint8Array(writeArchive(files))]),
      },
    );
    expect(uploaded.status, await uploaded.clone().text()).toBeLessThan(300);
    expect((await maintainer(["review", "spade-bot/fare-watcher@1.0.0", "--approve"])).code).toBe(
      0,
    );
    const signing = await maintainer(["sign", "--key", keyFile, "--json"]);
    const report = JSON.parse(signing.stdout) as { signed: string[]; blocked: unknown[] };
    expect(report.signed).toEqual([]);
    expect(report.blocked).toEqual([
      {
        version: "spade-bot/fare-watcher@1.0.0",
        reason: expect.stringContaining("Its tests failed when ace's market ran them"),
      },
    ]);
    // Never listed.
    expect((await market.fetch("/v1/entries/spade-bot/fare-watcher/1.0.0")).status).toBe(404);
    // The publisher's own page of the version says why, with the failing scenario.
    const own = await market.fetch("/v1/me/entries/spade-bot/fare-watcher", {
      headers: { authorization: `Bearer ${grant}` },
    });
    expect(own.status).toBe(200);
    const entry = MarketOwnEntry.parse(await own.json());
    expect(entry.versions).toEqual([
      expect.objectContaining({
        version: "1.0.0",
        status: "blocked",
        reason: expect.stringContaining('Says hello: The reply doesn\'t say "hello"'),
        scan: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ rule: "tests-failed", path: "tests/hello.json" }),
          ]),
        }),
      }),
    ]);
  },
  120_000,
);
