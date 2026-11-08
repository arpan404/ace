import { afterEach, expect, test } from "vitest";
import { installWebPlatform } from "@ace/native-host";
import { createNodeHost } from "@ace/native-host/node";
import { HostIdentityResult } from "@ace/protocol";

const nodeURL = globalThis.URL;
afterEach(() => {
  globalThis.URL = nodeURL;
});

/** The phone's JavaScriptCore has no URL: the bridge installs the host-backed one. */
function asOnThePhone() {
  const phone: { URL?: typeof URL } = {};
  installWebPlatform(createNodeHost(), phone);
  if (!phone.URL) throw new Error("expected the bridge's URL");
  globalThis.URL = phone.URL;
}

test("a machine's identity naming how else to reach it reads on the phone", () => {
  asOnThePhone();
  const result = HostIdentityResult.safeParse({
    type: "host.identity.result",
    requestId: "r1",
    identity: { hostId: "studio", displayName: "studio", version: "0.0.19", platform: "darwin" },
    paths: [
      { kind: "lan", url: "wss://192.168.1.4:7443", fingerprint: "a".repeat(64) },
      { kind: "account", url: "wss://relay.acehq.dev", relayHostId: "R".repeat(52) },
    ],
  });
  expect(result.success).toBe(true);
  expect(result.data?.paths?.map((path) => path.kind)).toEqual(["lan", "account"]);
});
