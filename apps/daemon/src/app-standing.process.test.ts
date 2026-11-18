import { appKeyPair, appSocketSignature } from "@ace/service/app-signature";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { hostConnection } from "./cli/connection.ts";
import { hostSocket } from "./host-socket-test-support.ts";
import { marketWorld } from "./market-world-test-support.ts";

/*
 * Who acts as the person on a real daemon (ADR 0178 §12.7, §12.8): the desktop app's page, by
 * the key it gave the daemon it started or the key it registered with one it didn't, and devices
 * whose pairing link the person made. A process holding only what ACE_HOME holds still needs a
 * fresh sign-in. A real daemon and real sockets: the proof is checked against the port each
 * socket reached, which only a listening daemon has.
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

/** What the app's main process asks a daemon it didn't start: the status and the run id. */
async function registerAppKey(home: string, publicKey: string) {
  const { origin, token } = hostConnection(home);
  const response = await fetch(new URL("/v1/app-key", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

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

test("on a daemon the app didn't start, the key it registered with a fresh sign-in makes its page the person's", async () => {
  let signedIn = Date.now();
  const { home } = await world({ signedInAt: () => signedIn });
  const app = appKeyPair(new Uint8Array(32).fill(1));
  // An agent's own key pair: it can ask too, with the host token it read.
  const agent = appKeyPair(new Uint8Array(32).fill(2));

  const registered = await registerAppKey(home, app.x);
  expect(registered.status).toBe(200);
  const run = z.object({ run: z.string() }).parse(registered.body).run;
  // One sign-in registers one key: the same sign-in can't register the agent's after it.
  expect((await registerAppKey(home, agent.x)).status).toBe(401);

  // Ten minutes on, the sign-in is stale; the registered key still holds.
  signedIn = elevenMinutesAgo();
  expect((await registerAppKey(home, agent.x)).status).toBe(401);
  const page = await hostSocket(home, "desktop-page", cleanup, {
    proof: (port) => appSocketSignature(app, port, run),
  });
  expect(await page.market("by-page", install)).not.toMatchObject({ code: "reauth" });

  const token = await hostSocket(home, "ace-cli", cleanup);
  const unregistered = await hostSocket(home, "ace-cli", cleanup, {
    proof: (port) => appSocketSignature(agent, port, run),
  });
  // A signature collected for another run of this daemon.
  const earlierRun = await hostSocket(home, "ace-cli", cleanup, {
    proof: (port) => appSocketSignature(app, port, "an-earlier-run"),
  });
  // A signature collected by a listener at another port.
  const otherPort = await hostSocket(home, "ace-cli", cleanup, {
    proof: (port) => appSocketSignature(app, port + 1, run),
  });
  for (const [name, socket] of Object.entries({ token, unregistered, earlierRun, otherPort }))
    expect(await socket.market(name, install), name).toMatchObject(reauth);
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
