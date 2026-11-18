import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { hostConnection } from "./cli/connection.ts";
import { hostSocket } from "./host-socket-test-support.ts";
import { marketWorld } from "./market-world-test-support.ts";

/*
 * Who acts as the person on a real daemon (ADR 0178 §12.7, §12.8): the desktop app's page, by
 * the key it gave the daemon it started, and devices whose pairing link the person made. A
 * process holding only what ACE_HOME holds still needs a fresh sign-in, and can't fake one. A
 * real daemon and real sockets: the proof is checked against the port each socket reached,
 * which only a listening daemon has, and freshness against a real account backend's keys.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});
const world = (options: Parameters<typeof marketWorld>[1] = {}) => marketWorld(cleanup, options);

const elevenMinutesAgo = () => Date.now() - 11 * 60_000;
const install = {
  op: "install",
  id: "rv-unknown",
  hash: "a".repeat(64),
  choices: { bots: [], needs: {}, startRoutines: false },
};
const reauth = { op: "error", code: "reauth" };

test("the desktop app's page installs, answers and changes the ask without a fresh sign-in; the host token alone can't", async () => {
  // The key the app gave its daemon on stdin, which no file holds.
  const appKey = new Uint8Array(32).fill(7);
  const { f, cli, home, market } = await world({ signedInAt: elevenMinutesAgo, appKey });
  const page = await hostSocket(home, "desktop-page", cleanup, { appKey });
  const token = await hostSocket(home, "ace-cli", cleanup);
  // A process that read every file in ACE_HOME can only guess at the key.
  const guessed = await hostSocket(home, "ace-cli", cleanup, { appKey: new Uint8Array(32) });

  for (const socket of [token, guessed])
    expect(await socket.market("by-token", install)).toMatchObject({ op: "error", code: "reauth" });
  // Past the sign-in check, the marketplace itself answers: there's no such review.
  expect(await page.market("by-page", install)).not.toMatchObject({ code: "reauth" });

  const ask = "market.askBeforeAgentPublish";
  expect(await page.settings("ask-on", ask, true)).toMatchObject({ ok: true });
  expect(await token.settings("ask-off", ask, false)).not.toMatchObject({ ok: true });
  expect((await f.daemon.settings.get(ask)).value).toBe(true);

  const asked = await cli(
    ["market", "withdraw", "spade-skill/triage-mail@1.0.0", "--reason", "Broken", "--json"],
    { ACE_THREAD_ID: f.caller.threadId },
  );
  const request = z.object({ request: z.string() }).loose().parse(JSON.parse(asked.stdout)).request;
  expect(await token.answer("by-token", request)).toMatchObject({ type: "error", code: "reauth" });
  expect(f.daemon.store.getInteraction(request)?.state).toBe("pending");
  expect(await page.answer("by-page", request)).toMatchObject({ type: "commandResult", ok: true });
  await expect.poll(() => market.seen.some((seen) => seen.path.endsWith("/withdraw"))).toBe(true);
});

test("a device whose pairing link the host token alone made needs a fresh sign-in; one the person's link made doesn't", async () => {
  const { f, home } = await world({ signedInAt: elevenMinutesAgo });
  const { origin } = hostConnection(home);
  const connect = async (name: string, person: boolean) => {
    const { device, token } = f.daemon.store.devices.create(
      name,
      ["admin"],
      Date.now(),
      null,
      undefined,
      person,
    );
    const response = await fetch(new URL("/v1/tickets", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const { ticket } = z.object({ ticket: z.string() }).parse(await response.json());
    return hostSocket(home, device.id, cleanup, { hello: { token: undefined, ticket } });
  };
  const byToken = await connect("Paired with the host token", false);
  const byPerson = await connect("Paired from the app", true);
  expect(await byToken.market("by-token", install)).toMatchObject(reauth);
  expect(await byPerson.market("by-person", install)).not.toMatchObject({ code: "reauth" });
});

test("a session pointing at a backend a host-token holder runs never makes a sign-in fresh", async () => {
  const { home } = await world();
  const { origin, token } = hostConnection(home);
  const socket = await hostSocket(home, "ace-cli", cleanup);
  // Signed in just now at the backend this daemon was started with: the install runs.
  expect(await socket.market("trusted", install)).not.toMatchObject({ code: "reauth" });

  // A process holding the host token hands the daemon a session at a backend of its own, which
  // mints market grants saying "signed in just now", signed with its own key.
  const forged = await startFakeAccountBackend(() => Date.now());
  cleanup.push(() => forged.close());
  await accessRequest(origin, "/v1/ace-account", {
    method: "PUT",
    token,
    body: { origin: forged.origin, token: forged.token },
  });
  expect(await socket.market("forged", install)).toMatchObject(reauth);
});

/** A device grant from `backend`'s session, as an ace account device would hold one. */
async function deviceGrant(backend: { origin: string; token: string }, deviceId: string) {
  const response = await fetch(new URL("/v1/grants", backend.origin), {
    method: "POST",
    headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "device", subject: deviceId }),
  });
  return z.object({ token: z.string() }).parse(await response.json()).token;
}

test("an account device counts as the person only by a grant from the backend this daemon trusts", async () => {
  const { home, backend } = await world({ signedInAt: elevenMinutesAgo });
  const { origin, token } = hostConnection(home);
  const trusted = await hostSocket(home, "phone-1", cleanup, {
    hello: { token: undefined, grant: await deviceGrant(backend, "phone-1") },
  });
  expect(await trusted.market("trusted", install)).not.toMatchObject({ code: "reauth" });

  // A host-token holder points the daemon at a backend of its own, which mints device grants
  // the daemon checks with that backend's own keys: admitted, but not the person.
  const forged = await startFakeAccountBackend(() => Date.now());
  cleanup.push(() => forged.close());
  await accessRequest(origin, "/v1/ace-account", {
    method: "PUT",
    token,
    body: { origin: forged.origin, token: forged.token },
  });
  const impostor = await hostSocket(home, "phone-2", cleanup, {
    hello: { token: undefined, grant: await deviceGrant(forged, "phone-2") },
  });
  expect(await impostor.market("forged", install)).toMatchObject(reauth);
});
