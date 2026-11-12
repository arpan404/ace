/**
 * Checks a deployed hosted relay without an account and without leaving anything behind:
 * the Worker answers, grant keys are published, a sign-in can start (and is cancelled), and
 * relay upgrades without a grant are refused.
 *
 *   node apps/cloud/scripts/smoke.ts https://relay.example.com
 */
import { WebSocket } from "ws";
import { GrantKeySet } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { aceAccountClient } from "@ace/client/ace-account";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: smoke.ts https://relay.example.com");
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
  if (!response.ok || !text.startsWith("ace relay")) throw new Error(`status ${response.status}`);
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
process.exitCode = failed ? 1 : 0;
