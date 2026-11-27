import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PairingResponse, SocketTicket, type DeviceCredential } from "@ace/protocol";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { invoke } from "./cli-test-support.ts";
import { startDaemonCli, temporaryHome, type Cleanups } from "./daemon-launch-test-support.ts";
import { publicKeyFingerprint } from "./tls-identity.ts";

/*
 * The cross-mode run (ADR 0226 §8): one fresh temporary home, booted alternately
 * by the Bun daemon and `ace-daemon-bin`. Each daemon must open what the other
 * wrote and keep the home's token, host id, pinned identity, devices, pending
 * pairing links and lock. Skipped unless ACE_TEST_DAEMON_BINARY names the binary.
 *
 * The Bun daemon signs its identity with OpenSSL, so PATH keeps the system tools
 * after an empty stub directory: no provider CLI is reachable from either daemon.
 *
 * Both daemons bind one port kept for the home, because a pairing link names the
 * origin it was issued at: redeeming a previous daemon's link proves the link is in
 * the database rather than in memory only if the next daemon answers at that origin.
 */
type Pairing = ReturnType<typeof PairingResponse.parse>;
const binary = process.env.ACE_TEST_DAEMON_BINARY;
const stub = mkdtempSync(join(tmpdir(), "ace-cross-stub-"));
const path = `${stub}:/usr/bin:/bin`;

async function publicFiles(home: string) {
  return {
    origin: readFileSync(join(home, "daemon-endpoint"), "utf8"),
    token: readFileSync(join(home, "daemon-token"), "utf8"),
    hostId: readFileSync(join(home, "host-id"), "utf8"),
    fingerprint: publicKeyFingerprint(readFileSync(join(home, "tls/cert.pem"))),
  };
}

async function stop(home: string): Promise<void> {
  const result = await invoke(home, ["stop", "--json", "--timeout", "60s"]);
  if (result.code !== 0)
    throw new Error(`stop failed (${result.code}): ${result.stdout} ${result.stderr}`);
}

async function pair(origin: string, token: string, name: string): Promise<DeviceCredential> {
  const issued = PairingResponse.parse(
    await accessRequest(origin, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read", "operate"] },
    }),
  );
  return redeemPairing(issued.url, name);
}

async function pendingLink(origin: string, token: string): Promise<Pairing> {
  return PairingResponse.parse(
    await accessRequest(origin, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read"] },
    }),
  );
}

/** A port nothing listens on, kept for every daemon that boots this home. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port was assigned");
  return address.port;
}

/** One home booted alternately; every value the home keeps is checked each time. */
async function rounds(
  home: string,
  cleanups: Cleanups,
  order: readonly ("bun" | "binary")[],
  port: number,
): Promise<void> {
  let kept: Awaited<ReturnType<typeof publicFiles>> | undefined;
  let device: DeviceCredential | undefined;
  let pending: Pairing | undefined;
  for (const backend of order) {
    const daemon = startDaemonCli(home, cleanups, undefined, {
      backend,
      env: {
        ACE_LISTEN: "lan",
        ACE_REMOTE_PORT: String(port),
        ACE_ADVERTISE_HOST: "127.0.0.1",
        ACE_LOG_LEVEL: "silent",
        PATH: path,
      },
    });
    await daemon.ready;
    // The other daemon implementation must never also own this home: refuse cleanly (exit 7).
    const rivalBackend = backend === "bun" ? "binary" : "bun";
    const rival = startDaemonCli(home, cleanups, undefined, {
      backend: rivalBackend,
      env: {
        ACE_LISTEN: "lan",
        ACE_REMOTE_PORT: String(port),
        ACE_ADVERTISE_HOST: "127.0.0.1",
        ACE_LOG_LEVEL: "silent",
        PATH: path,
      },
    });
    await expect(rival.ready).rejects.toThrow("Another daemon owns it");
    expect(await rival.exited).toBe(7);

    const files = await publicFiles(home);
    expect(await accessRequest(files.origin, "/v1/status", { token: files.token })).toMatchObject({
      running: true,
    });
    if (!kept) {
      kept = files;
      device = await pair(files.origin, files.token, "Cross phone");
      pending = await pendingLink(files.origin, files.token);
    } else {
      if (device === undefined) throw new Error("the first round paired a device");
      expect(files.token).toBe(kept.token);
      expect(files.hostId).toBe(kept.hostId);
      expect(files.fingerprint).toBe(kept.fingerprint);
      const devices = await accessRequest(files.origin, "/v1/devices", { token: files.token });
      expect(devices).toContainEqual(
        expect.objectContaining({ id: device.device.id, name: "Cross phone" }),
      );
      // The device's credential still mints a ticket under this daemon.
      const ticket = SocketTicket.parse(
        await accessRequest(files.origin, "/v1/tickets", {
          method: "POST",
          token: device.token,
        }),
      );
      expect(ticket.ticket).toMatch(/^[0-9a-f]{64}$/);
      // A link issued by the previous daemon still redeems here.
      if (pending) {
        const redeemed = await redeemPairing(pending.url, "Later phone");
        expect(redeemed.device.scopes).toEqual(["read"]);
        pending = undefined;
      }
    }
    await stop(home);
    expect(await daemon.exited).toBe(0);
  }
}

test.runIf(binary)(
  "a home boots alternately on Bun then the Rust daemon and keeps everything",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-cross-bun-first-", cleanups);
    await rounds(
      home,
      cleanups,
      ["bun", "binary", "bun", "binary", "bun", "binary"],
      await freePort(),
    );
  },
  600_000,
);

test.runIf(binary)(
  "a home boots alternately on the Rust daemon then Bun and keeps everything",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-cross-rust-first-", cleanups);
    await rounds(home, cleanups, ["binary", "bun", "binary", "bun"], await freePort());
  },
  600_000,
);
