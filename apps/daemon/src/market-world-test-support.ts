import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantPublicKey } from "@ace/account-grant";
import { contentHash, hashFiles, readArchive, typeLimits } from "@ace/marketplace";
import type { MarketDraft, MarketMe } from "@ace/protocol/marketplace";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
import { hostConnection } from "./cli/connection.ts";
import { accessRequest } from "./client-access.ts";
import { fakeMarket } from "./marketplace/test-support.ts";

/*
 * A real daemon, a fake market and a fake ace account (ADR 0178 §12), for the market's process
 * tests: the market answers `me`, draft uploads and withdrawals.
 */

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

/**
 * A daemon with the marketplace on, signed in to a fake ace account, beside a fake market.
 * `signedInAt` is read for each grant, so a test can move the account's sign-in.
 */
export async function marketWorld(
  cleanup: (() => Promise<unknown>)[],
  options: { signedInAt?: () => number; appKey?: Uint8Array } = {},
) {
  const backend = await startFakeAccountBackend(
    () => Date.now(),
    options.signedInAt ? { signedInAt: options.signedInAt } : {},
  );
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
    {
      ...(options.appKey ? { appKey: options.appKey } : {}),
      // This build trusts the fake backend's key for the person's standing, as a real one trusts
      // cloud.acehq.dev's (ADR 0178 §12.8). In code, never through the environment.
      personGrantKeys: { keys: [grantPublicKey(backend.signingKey)] },
    },
    { ACE_MARKET_URL: market.origin, ACE_ACCOUNT_URL: backend.origin },
  );
  cleanup.push(() => f.daemon.close());
  // The account backend signs grants on the wall clock and the daemon verifies them on its own
  // (ADR 0178 §12.8), so the two agree here, as on a real machine.
  f.h.clock.time = Date.now();
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
    // The person's own shell unless a test says otherwise: nothing from an agent session.
    invoke(home, args, "", { HOME: emptyHome, ACE_THREAD_ID: "", ACE_NO_INPUT: "", ...env });
  return { f, market, skill, cli, home, backend };
}
