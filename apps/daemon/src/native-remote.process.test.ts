// SPDX-License-Identifier: Apache-2.0
/**
 * The remote shell hands its timers to N-API (T1b.1b). `headMs` and `trustedKeepAliveMs` are
 * optional in `ConnectionLimits`, and JavaScript says so with `null`: a start that passes them must
 * bind and serve, or the static listener's own limits are unusable.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { loadIdentity } from "./tls-identity.ts";
import { startNativeRemote } from "./native-remote.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { transportParts } from "@ace/provider-kit/native-switches";

const identity = loadIdentity(tlsFixtureHome());

/** A GET through TLS, its status the answer. */
function status(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

const upgrades: NativeUpgrade = {
  admit: async () => ({ decision: "accept", reservation: 0 }),
  release: () => {},
  opened: () => {},
};

describe.runIf(transportParts().has("remote"))("the native remote shell's timers", () => {
  it("binds and serves when the optional limits are null", async () => {
    const target = createServer((_request, response) => response.end("ok"));
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("No target port");
    const errors: string[] = [];
    const listener = await startNativeRemote({
      host: "127.0.0.1",
      port: 0,
      targetPort: address.port,
      identity,
      hopSecret: transportAddon().NativeLoopback.generateSecret(),
      limits: {
        handshakeMs: 5_000,
        firstHeadMs: 5_000,
        headMs: null,
        keepAliveMs: 5_000,
        trustedKeepAliveMs: null,
      },
      upgrade: upgrades,
      holdPort: () => () => {},
      log: (error) => errors.push(error.message),
    });
    try {
      expect(await status(listener.port())).toBe(200);
    } finally {
      await listener.close(0);
      target.close();
      await once(target, "close");
    }
    expect(errors).toEqual([]);
  }, 30_000);
});
