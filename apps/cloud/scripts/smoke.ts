/**
 * Checks a deployed ace cloud without an account and without leaving anything behind: the
 * Worker answers, grant keys are published, a sign-in can start (and is cancelled), relay
 * upgrades without a grant are refused, and Spade's sign-in broker refuses a request without a
 * cloud credential. Run it against each of its hostnames.
 *
 *   node apps/cloud/scripts/smoke.ts https://cloud.acehq.dev
 */
import { WebSocket } from "ws";
import { GrantKeySet } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { aceAccountClient } from "@ace/client/ace-account";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: smoke.ts https://cloud.example.com");
const origin = new URL(argument).origin;
const signal = AbortSignal.timeout(15_000);
let failed = false;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The HTTP status of an upgrade the relay refuses before switching protocols. */
function refusedUpgrade(path: string): Promise<number> {
  const url = new URL(path, origin.replace(/^http/, "ws"));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.toString());
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("upgrade was accepted without a grant"));
    });
    socket.once("error", (error) => reject(error));
  });
}

await check("the Worker answers", async () => {
  const response = await fetch(origin, { signal });
  const text = await response.text();
  if (!response.ok || !text.startsWith("ace cloud")) throw new Error(`status ${response.status}`);
});
await check("grant keys are published", async () => {
  const response = await fetch(`${origin}/v1/keys`, { signal });
  if (!response.ok) throw new Error(`status ${response.status} (are the account secrets set?)`);
  GrantKeySet.parse(await response.json());
});
await check("a sign-in starts and is cancelled", async () => {
  const account = aceAccountClient({ origin, fetch });
  const login = await account.login(signal);
  await account.cancel(login, signal);
});
const someHost = hostId(keyPair().publicKey);
await check("a daemon without a grant is refused", async () => {
  const status = await refusedUpgrade(`/host?hostId=${someHost}`);
  if (status !== 401) throw new Error(`status ${status}, expected 401`);
});
await check("a client without a grant is refused", async () => {
  const status = await refusedUpgrade(`/client?hostId=${someHost}`);
  if (status !== 401) throw new Error(`status ${status}, expected 401`);
});
await check("the sign-in broker wants a cloud credential", async () => {
  const response = await fetch(`${origin}/v1/oauth/asana/start`, { method: "POST", signal });
  const body: unknown = await response.json();
  if (response.status !== 401 || JSON.stringify(body) !== '{"error":"unauthorized"}')
    throw new Error(`status ${response.status}, expected 401 unauthorized`);
});
await check("a callback naming no sign-in is turned away", async () => {
  const response = await fetch(`${origin}/v1/oauth/callback/asana?state=none&code=x`, { signal });
  await response.body?.cancel();
  if (response.status !== 400) throw new Error(`status ${response.status}, expected 400`);
});
process.exitCode = failed ? 1 : 0;
