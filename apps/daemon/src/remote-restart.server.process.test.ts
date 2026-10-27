import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PairingResponse, SocketTicket } from "@ace/protocol";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { readConfig } from "./config.ts";
import { startDaemon } from "./index.ts";
import { cleanups } from "./remote-test-support.ts";

it.runIf(process.platform === "win32")(
  "on Windows, a LAN daemon makes its TLS identity itself, and pairing and revocation survive a restart",
  async () => {
    // A fresh home with no TLS fixture: the daemon makes its own identity, without OpenSSL.
    const home = mkdtempSync(join(tmpdir(), "ace-remote-restart-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const config = readConfig({
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "lan",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_LOG_LEVEL: "silent",
    });
    const first = await startDaemon({ config });
    cleanups.push(() => first.close());
    const credential = readFileSync(first.tokenPath, "utf8");
    const origin = readFileSync(join(home, "daemon-endpoint"), "utf8");
    if (!first.remoteUrl || !first.fingerprint) throw new Error("Remote listener missing");
    const issued = PairingResponse.parse(
      await accessRequest(origin, "/v1/pairings", { token: credential, method: "POST", body: {} }),
    );
    const paired = await redeemPairing(issued.url, "Phone");
    await first.close();

    const second = await startDaemon({ config });
    cleanups.push(() => second.close());
    if (!second.remoteUrl || !second.fingerprint) throw new Error("Remote listener missing");
    expect(second.fingerprint).toBe(first.fingerprint);
    const remote = second.remoteUrl.replace("wss:", "https:");
    const ticket = (fingerprint: string) =>
      accessRequest(remote, "/v1/tickets", { token: paired.token, fingerprint, method: "POST" });
    expect(SocketTicket.parse(await ticket(second.fingerprint)).ticket).toBeTruthy();
    // A client pinned to another key never sends its token.
    await expect(ticket("0".repeat(64))).rejects.toThrow(/fingerprint mismatch/);

    // The restarted daemon listens on a new local port (the test binds port 0).
    const local = readFileSync(join(home, "daemon-endpoint"), "utf8");
    expect(
      await accessRequest(local, `/v1/devices/${paired.device.id}`, {
        token: readFileSync(second.tokenPath, "utf8"),
        method: "DELETE",
      }),
    ).toEqual({ revoked: true });
    await expect(ticket(second.fingerprint)).rejects.toThrow("HTTP 401");
  },
);
