import { ClientCore, ClientError } from "@ace/client";
import { MachineDirectory } from "@ace/client/machines";
import { DeviceId, type HostIdentity } from "@ace/protocol";
import { z } from "zod";
import { call, host, scheduler } from "./host.ts";
import { pairedCredential, type PinnedHttp, type TrustMonitor } from "./access.ts";
import { performAccess, type AccessResult } from "./pairing.ts";
import { nativeTransport } from "./socket.ts";

const Response = z.strictObject({ status: z.number().int().min(100).max(599), body: z.string() });

/** Swift performs the request on its pinned URLSession; refusals reject with their reason. */
export const nativeHttp: PinnedHttp = async (request) =>
  Response.parse(JSON.parse(await call("http", request)));

/** Device tokens live in the iOS Keychain. Swift scopes which keys a runtime may touch. */
const secrets = {
  get: async (key: string) => (await call("secret.get", key)) || null,
  set: async (key: string, token: string) => {
    await call("secret.set", { key, token });
  },
  delete: async (key: string) => {
    await call("secret.delete", key);
  },
};

const noop = () => {};

/** A short-lived pinned connection authenticated as the new device, closed after one read. */
async function readIdentity(
  deviceId: string,
  token: string,
  trust: TrustMonitor,
): Promise<HostIdentity> {
  const client = new ClientCore({
    deviceId: DeviceId.parse(deviceId),
    transport: () => nativeTransport(trust),
    credential: pairedCredential(nativeHttp, async () => token, trust),
    storage: { load: async () => null, save: async () => {} },
    scheduler,
    id: () => host.uuid(),
    random: () => host.random(),
    now: () => host.now(),
  });
  const connection = client.connectionState();
  let stop = noop;
  let cancel = noop;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      cancel = scheduler.set(15_000, () =>
        reject(new ClientError("offline", "This computer didn't respond")),
      );
      const changed = () => {
        const state = connection.getSnapshot();
        if (state === "ready") resolve();
        else if (state === "fatal") reject(client.error ?? new ClientError("auth"));
        else if (state === "reconnecting") reject(new ClientError("offline"));
      };
      stop = connection.subscribe(changed);
      changed();
    });
    await Promise.all([client.start(), ready]);
    const { identity } = await client.request({ type: "host.identity", requestId: host.uuid() });
    return identity;
  } finally {
    stop();
    cancel();
    await client.close();
  }
}

async function access(json: string): Promise<AccessResult> {
  const directory = new MachineDirectory(
    {
      load: async () => (await call("directory.load")) || null,
      save: async (value) => {
        await call("directory.save", null, value);
      },
    },
    secrets,
  );
  return performAccess({ http: nativeHttp, directory, identity: readIdentity }, JSON.parse(json));
}

/** Entry point for pairing and machine-directory runtimes; the result ends the VM's work. */
export function aceAccess(json: string): void {
  void access(json)
    .catch((): AccessResult => ({
      ok: false,
      problem: { code: "unknown", message: "Couldn't complete the request. Try again." },
    }))
    .then((result) => call("access.result", null, JSON.stringify(result)))
    .catch(() => {});
}
