import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { DeviceId, PairingResponse, SocketTicket } from "@ace/protocol";
import { loadIdentity } from "./tls-identity.ts";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { fixture, token } from "./socket-test-support.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
const binary = () => process.env.ACE_TEST_DAEMON_BINARY;

/** The fixture's pinned identity, or an empty stand-in when the binary makes its own. */
export const identity = binary()
  ? { key: Buffer.alloc(0), cert: Buffer.alloc(0), fingerprint: "" }
  : loadIdentity(tlsFixtureHome());
export const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
}, 60_000);
export async function setup(
  serverOptions: Parameters<typeof fixture>[0] = {},
  /** Services that need the fixture's own store and home. */
  withStore?: Parameters<typeof fixture>[1],
) {
  let time = 1000;
  // The binary advances its clock through a file, so ticket expiry and rate
  // windows need no real wait. Both modes start at 1000.
  const clockFile = join(mkdtempSync(join(tmpdir(), "ace-remote-clock-")), "offset");
  writeFileSync(clockFile, "0");
  const f = await fixture(
    {
      ...serverOptions,
      now: () => time,
      remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity },
      ...(binary()
        ? {
            binaryEnv: {
              ACE_TEST_CLOCK_BASE_MS: "1000",
              ACE_TEST_CLOCK_FILE: clockFile,
              ...(typeof serverOptions.pairingAddress === "function"
                ? { ACE_TEST_PAIRING_ADDRESSES: "distinct" }
                : {}),
            },
          }
        : {}),
    },
    withStore,
  );
  cleanups.push(() => f.close());
  const remoteUrl = f.server.remoteUrl;
  if (!remoteUrl) throw new Error("Remote listener missing");
  const remote = remoteUrl.replace("wss:", "https:");
  const local = f.server.httpUrl;
  const request = (path: string, options: Parameters<typeof accessRequest>[2] = {}) =>
    accessRequest(local, path, options);
  const fingerprint = f.server.fingerprint ?? identity.fingerprint;
  const remoteRequest = (path: string, options: Parameters<typeof accessRequest>[2] = {}) =>
    accessRequest(remote, path, { ...options, fingerprint });
  const pairing = async (scopes = ["read", "operate"]) => {
    return PairingResponse.parse(
      await request("/v1/pairings", { method: "POST", token, body: { scopes } }),
    );
  };
  const pair = async (scopes = ["read", "operate"]) =>
    redeemPairing((await pairing(scopes)).url, "Phone");
  const ticket = async (credential: string) =>
    SocketTicket.parse(await remoteRequest("/v1/tickets", { method: "POST", token: credential }));
  const connect = async (deviceId: string, issuedTicket: string) => {
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(deviceId),
      ticket: issuedTicket,
    });
    return client;
  };
  return {
    ...f,
    server: { ...f.server, remoteUrl },
    request,
    remoteRequest,
    pairing,
    pair,
    ticket,
    connectTicket: connect,
    advance: (ms: number) => {
      time += ms;
      if (binary()) writeFileSync(clockFile, String(time - 1000));
    },
  };
}
