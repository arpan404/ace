import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GrantKeySet, verifyGrant, verifyStandingGrant } from "@ace/account-grant";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { hostId, keyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * ADR 0189 against the real Worker and D1 under Miniflare: what a machine keeps can never mint a
 * grant that speaks for the person. A real Worker because the rules live in its routes, its SQL
 * and its migration together.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterEach(() => workos.fail());
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const person: WorkosUser = {
  id: "user_m",
  email: "m@example.com",
  first_name: "Mia",
  last_name: null,
};
const signal = () => AbortSignal.timeout(20_000);
const account = () => aceAccountClient({ origin: worker.http, fetch });
const keys = async () => GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());

/** The standing a device grant minted with `token` carries. */
async function standingOf(token: string, device = "phone") {
  const grant = await account().grant(token, { kind: "device", subject: device }, signal());
  if (!grant.standing) throw new Error("No standing grant");
  const claims = verifyStandingGrant(grant.standing, await keys(), Date.now());
  // The standing grant names the device grant's own account and device.
  const device1 = verifyGrant(grant.token, await keys(), Date.now(), "device");
  expect([claims.account, claims.subject]).toEqual([device1.account, device1.subject]);
  return claims.standing;
}

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 200;
  } catch (error) {
    if (error instanceof AceAccountError) return error.status;
    throw error;
  }
};

it("the person signing in in a browser gets device grants with the person's standing", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  expect(await standingOf(session.token)).toBe("person");
});

it("a machine credential's grants never give person standing, and it speaks only for its machine", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const machine = hostId(keyPair().publicKey);
  const credential = await account().machineCredential(
    session.token,
    { hostId: machine },
    signal(),
  );
  expect(credential.account.id).toBe("user_m");
  expect(await standingOf(credential.token)).toBe("machine");
  // The relay grant and the market grant name this machine; another machine's are refused.
  const relay = await account().grant(
    credential.token,
    { kind: "machine", subject: machine },
    signal(),
  );
  expect(verifyGrant(relay.token, await keys(), Date.now(), "machine").subject).toBe(machine);
  const other = hostId(keyPair().publicKey);
  expect(
    await status(() =>
      account().grant(credential.token, { kind: "machine", subject: other }, signal()),
    ),
  ).toBe(403);
  // A credential can't be exchanged into another, and doesn't change the account's machines.
  expect(
    await status(() => account().machineCredential(credential.token, { hostId: other }, signal())),
  ).toBe(403);
  expect(await status(() => account().forgetMachine(credential.token, machine, signal()))).toBe(
    403,
  );
  // The exchange took nothing from the session the app keeps: it still speaks for the person.
  expect(await standingOf(session.token)).toBe("person");
  // The credential lives on that session: signing the session out ends it.
  await account().logout(session.token, signal());
  expect(await status(() => account().session(credential.token, signal()))).toBe(401);
});

it("a session an older daemon keeps on its disk loses the person's standing for good", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  // An older daemon asks for its relay grant with the session it wrote to ace-account.json.
  await account().grant(
    session.token,
    { kind: "machine", subject: hostId(keyPair().publicKey) },
    signal(),
  );
  expect(await standingOf(session.token)).toBe("machine");
});

it("a session from before standing was kept speaks for the person no more", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  await worker.db.prepare("UPDATE sessions SET standing = 'legacy'").run();
  expect(await standingOf(session.token)).toBe("machine");
});

it("a session exchanged by its only holder stops working by its old token, and signing the machine out ends it", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const before = await worker.db.prepare("SELECT count(*) AS n FROM sessions").first("n");
  const credential = await account().machineCredential(
    session.token,
    { hostId: hostId(keyPair().publicKey), sole: true },
    signal(),
  );
  // Whoever copied the session file before the exchange holds a dead token.
  expect(await status(() => account().session(session.token, signal()))).toBe(401);
  expect((await account().session(credential.token, signal())).account.id).toBe("user_m");
  expect(await standingOf(credential.token)).toBe("machine");
  await account().logout(credential.token, signal());
  expect(await status(() => account().session(credential.token, signal()))).toBe(401);
  expect(await worker.db.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(
    Number(before) - 1,
  );
});
