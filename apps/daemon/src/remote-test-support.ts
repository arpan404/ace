import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { DeviceId, PairingResponse, SocketTicket } from "@ace/protocol";
import { loadIdentity } from "./tls-identity.ts";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { fixture, token } from "./socket-test-support.ts";
const certificateHome = mkdtempSync(join(tmpdir(), "ace-tls-"));
export const identity = loadIdentity(certificateHome);
afterAll(() => rmSync(certificateHome, { recursive: true, force: true }));
export const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
export async function setup() {
  let time = 1000;
  const f = await fixture({
    now: () => time,
    remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity },
  });
  cleanups.push(() => f.close());
  const remoteUrl = f.server.remoteUrl;
  if (!remoteUrl) throw new Error("Remote listener missing");
  const remote = remoteUrl.replace("wss:", "https:");
  const local = f.server.httpUrl;
  const request = (path: string, options: Parameters<typeof accessRequest>[2] = {}) =>
    accessRequest(local, path, options);
  const remoteRequest = (path: string, options: Parameters<typeof accessRequest>[2] = {}) =>
    accessRequest(remote, path, { ...options, fingerprint: identity.fingerprint });
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
    },
  };
}
