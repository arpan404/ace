import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import { verifyOfficialList, verifyVerifiedList } from "@ace/marketplace";
import { keySetOf, sampleSkill } from "@ace/marketplace/testing";
import { marketKey, publish, signerToken, startMarket, type Market } from "./testing/harness.ts";
import { publishLive } from "./testing/discover-harness.ts";

/*
 * The maintainers' `ace market` commands (ADR 0174 §10) as a maintainer runs them: the real CLI
 * in its own process, over HTTP to the Worker, with the signer's token and a key file.
 */

const cli = fileURLToPath(import.meta.resolve("../../daemon/src/cli.ts"));
const run = promisify(execFile);
let market: Market;
let home: string;
let keyFile: string;

beforeAll(async () => {
  market = await startMarket();
  home = await mkdtemp(join(tmpdir(), "ace-market-cli-"));
  keyFile = join(home, "market.key");
  await writeFile(
    keyFile,
    JSON.stringify({ id: marketKey.id, privateKey: encodeBase64url(marketKey.privateKey) }),
    { mode: 0o600 },
  );
});
afterAll(async () => {
  await market.close();
  await rm(home, { recursive: true, force: true });
});

/** `ace market …`; resolves with its output, rejects with it when the command fails. */
async function ace(...words: string[]): Promise<string> {
  const { stdout } = await run(
    "bun",
    [cli, "market", ...words, "--dev-market", market.url.origin],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        ACE_HOME: join(home, "ace"),
        ACE_MARKET_SIGNER_TOKEN: signerToken,
      },
    },
  );
  return stdout;
}
const json = async (...words: string[]) => JSON.parse(await ace(...words, "--json")) as unknown;

it("review lists the queue as sentences, then approves and blocks by version", async () => {
  await publish(market, { type: "spade-skill", name: "cli-held", files: sampleSkill("cli-held") });
  await publish(market, {
    type: "spade-skill",
    name: "cli-blocked",
    files: sampleSkill("cli-blocked"),
    account: "acct_b",
    publisher: "other-folk",
  });
  const listed = await ace("review");
  expect(listed).toContain("Held: spade-skill/cli-held@1.0.0 by tester, a new publisher");
  expect(listed).toContain("Held: spade-skill/cli-blocked@1.0.0 by other-folk");
  expect(await ace("review", "spade-skill/cli-held@1.0.0", "--show")).toContain("cli-held");

  expect(await ace("review", "spade-skill/cli-held@1.0.0", "--approve")).toContain("Released");
  expect(
    await ace("review", "spade-skill/cli-blocked@1.0.0", "--block", "Copies another"),
  ).toContain("Blocked");
  const after = await ace("review");
  expect(after).not.toContain("cli-held");
  expect(after).not.toContain("cli-blocked");
  const signed = (await json("sign", "--key", keyFile)) as { signed: string[] };
  expect(signed.signed).toEqual(["spade-skill/cli-held@1.0.0"]);
  // The review-mark form still works.
  expect(await json("review", "spade-skill/cli-held@1.0.0", "--key", keyFile, "--by-ace")).toEqual({
    ok: true,
  });
});

it("reports lists anonymous reports and resolves one", async () => {
  await publishLive(market, {
    type: "spade-skill",
    name: "cli-reported",
    files: sampleSkill("cli-reported"),
  });
  await market.fetch("/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "spade-skill",
      name: "cli-reported",
      reason: "impersonation",
      note: "Looks like ace",
    }),
  });
  const reports = (await json("reports")) as { id: string; state: string }[];
  const id = reports[0]?.id ?? "";
  expect(await ace("reports")).toContain(
    `${id} (open): spade-skill/cli-reported reported for impersonation`,
  );
  await ace("reports", "resolve", id, "--state", "kept", "--note", "Checked, it's fine");
  expect(await ace("reports")).toContain(`${id} (kept: Checked, it's fine)`);
  await expect(ace("reports", "resolve", id, "--state", "open")).rejects.toThrow();
});

it("collection puts, lists and removes the maintainers' collections", async () => {
  await publishLive(market, {
    type: "spade-skill",
    name: "cli-collected",
    files: sampleSkill("cli-collected"),
  });
  await ace(
    "collection",
    "put",
    "mail",
    "--title",
    "Mail",
    "--line",
    "For the inbox",
    "spade-skill/cli-collected",
  );
  expect(await ace("collection", "list")).toContain(
    "mail: Mail (For the inbox) holds spade-skill/cli-collected.",
  );
  await ace("collection", "put", "mail", "--title", "Mail, again", "spade-skill/cli-collected");
  expect((await json("collection", "list")) as { title: string }[]).toEqual([
    expect.objectContaining({ id: "mail", title: "Mail, again" }),
  ]);
  await ace("collection", "remove", "mail");
  expect(await ace("collection", "list")).toContain("No collections.");
});

it("verify and unverify sign the verified list; the publisher sees why", async () => {
  await publishLive(market, {
    type: "spade-skill",
    name: "cli-verified",
    files: sampleSkill("cli-verified"),
    account: "acct_cv",
    publisher: "verify-me",
  });
  await ace("verify", "verify-me", "--reason", "Owns the domain", "--key", keyFile);
  const on = verifyVerifiedList(
    await (await market.fetch("/v1/verified")).json(),
    keySetOf(marketKey),
  );
  expect(on.publishers.map((publisher) => [publisher.handle, publisher.proofs])).toEqual([
    ["verify-me", [{ kind: "account" }]],
  ]);
  await ace("unverify", "verify-me", "--reason", "The domain lapsed", "--key", keyFile);
  const off = verifyVerifiedList(
    await (await market.fetch("/v1/verified")).json(),
    keySetOf(marketKey),
  );
  expect(off.publishers).toEqual([]);
  expect(
    await market.dbs.publishers
      .prepare("SELECT verification, verification_reason FROM publishers WHERE name = 'verify-me'")
      .first(),
  ).toEqual({ verification: "revoked", verification_reason: "The domain lapsed" });
});

it("official add and remove sign the official list with the ace publisher's id", async () => {
  await ace("official", "add", "acct_owner_one", "--key", keyFile);
  await ace("official", "add", "acct_owner_two", "--key", keyFile);
  const list = verifyOfficialList(
    await (await market.fetch("/v1/official")).json(),
    keySetOf(marketKey),
  );
  expect(list.publisher.name).toBe("ace");
  expect(list.accounts).toEqual(["acct_owner_one", "acct_owner_two"]);
  const acePublisher = await market.dbs.publishers
    .prepare("SELECT id FROM publishers WHERE name = 'ace'")
    .first<{ id: string }>();
  expect(acePublisher?.id).toBe(list.publisher.id);

  await ace("official", "remove", "acct_owner_one", "--key", keyFile);
  const rows = await market.dbs.publishers
    .prepare("SELECT account, publisher FROM official_accounts")
    .all();
  expect(rows.results).toEqual([{ account: "acct_owner_two", publisher: list.publisher.id }]);
  await expect(ace("official", "remove", "acct_nobody", "--key", keyFile)).rejects.toThrow();
});
