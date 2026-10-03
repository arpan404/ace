import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { connect as connectTcp } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DeviceId, CommandId, PairingResponse, SocketTicket } from "@ace/protocol";
import { accessRequest, pinnedAgent, redeemPairing, ticketSocket } from "./client-access.ts";
import { readConfig } from "./config.ts";
import { startDaemon } from "./index.ts";
import { Client, fixture, token } from "./socket-test-support.ts";

import { cleanups, identity, setup } from "./remote-test-support.ts";
describe("remote access", () => {
  it("carries the pin and one-time code only in the URL fragment and consumes the code once", async () => {
    const f = await setup();
    const pairing = await f.pairing();
    const url = new URL(pairing.url);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/pair");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("fingerprint")).toBe(identity.fingerprint);
    expect(fragment.get("code")).toMatch(/^[0-9a-f]{64}$/);
    const result = await redeemPairing(pairing.url, "Phone");
    expect(result.device).toMatchObject({ name: "Phone", scopes: ["read", "operate"] });
    await expect(redeemPairing(pairing.url, "Second phone")).rejects.toThrow("HTTP 401");
    expect(pairing.expiresAt).toBe(301000);
  });
  it("expires a pairing code at five minutes", async () => {
    const f = await setup();
    const { url } = await f.pairing();
    f.advance(300000);
    await expect(redeemPairing(url, "Late phone")).rejects.toThrow("HTTP 401");
    expect(await f.request("/v1/devices", { token })).toEqual([]);
  });
  it("rate limits wrong codes and permits another attempt after the window", async () => {
    const f = await setup();
    for (let i = 0; i < 5; i++)
      await expect(
        f.remoteRequest("/v1/pair", { method: "POST", body: { code: "wrong", name: "Phone" } }),
      ).rejects.toThrow("HTTP 401");
    const { url } = await f.pairing();
    await expect(redeemPairing(url, "Phone")).rejects.toThrow("HTTP 429");
    f.advance(60000);
    expect(await redeemPairing(url, "Phone")).toMatchObject({ device: { name: "Phone" } });
  });
  it("stores only a SHA-256 token hash and returns no token in device listings", async () => {
    const f = await setup();
    const paired = await f.pair();
    expect(Buffer.from(paired.token, "hex").length).toBeGreaterThanOrEqual(32);
    const db = new DatabaseSync(join(f.home, "events.sqlite"));
    try {
      const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(paired.device.id);
      if (!row) throw new Error("Device not stored");
      expect(row.token_hash).toBe(createHash("sha256").update(paired.token).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(paired.token);
    } finally {
      db.close();
    }
    const devices = await f.request("/v1/devices", { token });
    expect(devices).toMatchObject([{ id: paired.device.id, name: "Phone", revokedAt: null }]);
    expect(JSON.stringify(devices)).not.toContain(paired.token);
    expect(JSON.stringify(devices)).not.toContain("token_hash");
  });
  it("consumes a socket ticket once and accepts it on a pinned WSS connection", async () => {
    const f = await setup();
    const paired = await f.pair();
    const issued = await f.ticket(paired.token);
    expect(issued.expiresAt).toBe(61000);
    const socket = ticketSocket(f.server.remoteUrl, identity.fingerprint);
    const close = once(socket, "close");
    cleanups.push(async () => {
      if (socket.readyState !== socket.CLOSED) socket.close();
      await close;
    });
    await once(socket, "open");
    const message = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId: paired.device.id,
        ticket: issued.ticket,
      }),
    );
    expect(JSON.parse(String((await message)[0]))).toMatchObject({ type: "welcome" });
    const again = await f.connectTicket(paired.device.id, issued.ticket);
    expect(await again.next()).toMatchObject({ type: "error", code: "unauthorized" });
  });
  it("expires a socket ticket at sixty seconds", async () => {
    const f = await setup();
    const paired = await f.pair();
    const issued = await f.ticket(paired.token);
    f.advance(60000);
    const client = await f.connectTicket(paired.device.id, issued.ticket);
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  });
  it("lets a read device subscribe but refuses commands before they change the store", async () => {
    const f = await setup();
    const paired = await f.pair(["read"]);
    const issued = await f.ticket(paired.token);
    const client = await f.connectTicket(paired.device.id, issued.ticket);
    expect((await client.next()).type).toBe("welcome");
    client.send({ type: "subscribe", subscriptionId: "threads", scope: { kind: "threads" } });
    expect(await client.next()).toMatchObject({ type: "snapshot", view: { kind: "threads" } });
    client.send({
      type: "command",
      command: {
        id: CommandId.parse("archive"),
        deviceId: DeviceId.parse(paired.device.id),
        payload: { type: "thread.archive", threadId: f.thread.id },
      },
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    expect(f.store.getThread(f.thread.id)?.archivedAt).toBeUndefined();
    await expect(f.remoteRequest("/v1/devices", { token: paired.token })).rejects.toThrow(
      "HTTP 403",
    );
    await expect(
      f.remoteRequest("/v1/pairings", {
        method: "POST",
        token: paired.token,
        body: { scopes: ["admin"] },
      }),
    ).rejects.toThrow("HTTP 403");
  });
  it("lets an operate device archive a thread and refuses reads without read scope", async () => {
    const f = await setup();
    const paired = await f.pair(["operate"]);
    const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    await client.next();
    client.send({ type: "subscribe", subscriptionId: "s", scope: { kind: "threads" } });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    client.send({
      type: "command",
      command: {
        id: CommandId.parse("archive"),
        deviceId: DeviceId.parse(paired.device.id),
        payload: { type: "thread.archive", threadId: f.thread.id },
      },
    });
    expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
    expect(f.store.getThread(f.thread.id)?.archivedAt).toBeTypeOf("number");
  });
  it("revokes a device immediately, closes all its sockets and rejects outstanding tickets and tokens", async () => {
    const f = await setup();
    const paired = await f.pair();
    const first = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    await first.next();
    const second = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    await second.next();
    const pending = await f.ticket(paired.token);
    const closed = [once(first.socket, "close"), once(second.socket, "close")];
    expect(await f.request(`/v1/devices/${paired.device.id}`, { method: "DELETE", token })).toEqual(
      { revoked: true },
    );
    for (const live of [first, second]) {
      if (live.socket.readyState === live.socket.OPEN) live.send({ type: "ping" });
      await expect(live.next()).rejects.toThrow("Socket closed");
    }
    await Promise.all(closed);
    await expect(f.ticket(paired.token)).rejects.toThrow("HTTP 401");
    const client = await f.connectTicket(paired.device.id, pending.ticket);
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    expect(await f.request("/v1/devices", { token })).toMatchObject([{ revokedAt: 1000 }]);
  });
  it("keeps the local token working while rejecting it and device tokens in remote hello", async () => {
    const f = await setup();
    const local = await f.connect();
    expect((await local.next()).type).toBe("welcome");
    const paired = await f.pair();
    const agent = pinnedAgent(identity.fingerprint);
    cleanups.push(() => agent.destroy());
    for (const credential of [token, paired.token]) {
      const client = new Client(f.server.remoteUrl, { agent });
      cleanups.push(() => client.close());
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse(paired.device.id),
        token: credential,
      });
      expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    }
    await expect(f.remoteRequest("/v1/devices", { token })).rejects.toThrow("HTTP 403");
  });
  it("rejects a ticket used with another device's identity", async () => {
    const f = await setup();
    const paired = await f.pair();
    const client = await f.connectTicket("imposter", (await f.ticket(paired.token)).ticket);
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  });
  it("rejects a TLS fingerprint mismatch before redeeming the code", async () => {
    const f = await setup();
    const { url } = await f.pairing();
    const wrong = new URL(url);
    const fragment = new URLSearchParams(wrong.hash.slice(1));
    fragment.set("fingerprint", "0".repeat(64));
    wrong.hash = fragment.toString();
    await expect(redeemPairing(wrong.toString(), "Phone")).rejects.toThrow("fingerprint mismatch");
    expect(await redeemPairing(url, "Phone")).toMatchObject({ device: { name: "Phone" } });
    const socket = ticketSocket(f.server.remoteUrl, "0".repeat(64));
    const closed = once(socket, "close");
    expect((await once(socket, "error"))[0].message).toContain("fingerprint mismatch");
    await closed.catch(() => {});
  });
  it("does not accept credentials in HTTP or socket URLs or unpinned remote requests", async () => {
    const f = await setup();
    await expect(
      accessRequest(f.server.httpUrl, "/v1/status?token=secret", { token }),
    ).rejects.toThrow("request URLs");
    expect(() => ticketSocket(f.server.remoteUrl + "?ticket=secret", identity.fingerprint)).toThrow(
      "without credentials",
    );
    await expect(
      accessRequest(f.server.remoteUrl.replace("wss:", "https:"), "/v1/status"),
    ).rejects.toThrow("fingerprint");
  });
  it("defaults to loopback only and requires explicit network exposure before pairing", async () => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const lanAddress = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
    if (lanAddress) {
      const attempted = connectTcp({ host: lanAddress, port: Number(new URL(f.server.url).port) });
      await new Promise<void>((resolve, reject) => {
        attempted.once("connect", () => {
          attempted.destroy();
          reject(new Error("Default listener exposed the LAN"));
        });
        attempted.once("error", (error) => {
          if ("code" in error && error.code === "ECONNREFUSED") resolve();
          else reject(error);
        });
      });
    }
    expect(f.server.remoteUrl).toBeUndefined();
    expect(await accessRequest(f.server.httpUrl, "/v1/status", { token })).toEqual({
      running: true,
      ready: true,
      version: "development",
      remote: null,
    });
    await expect(
      accessRequest(f.server.httpUrl, "/v1/pairings", { method: "POST", token, body: {} }),
    ).rejects.toThrow("Remote access is off");
    expect(readConfig({}).listen).toBe("local");
  });
  it("persists device credentials and the private TLS identity across daemon restarts in LAN mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-remote-restart-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const config = readConfig({
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "lan",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_LOG_LEVEL: "silent",
    });
    const first = await startDaemon({ config: config });
    cleanups.push(() => first.close());
    const credential = readFileSync(first.tokenPath, "utf8");
    const origin = readFileSync(join(home, "daemon-endpoint"), "utf8");
    if (!first.remoteUrl || !first.fingerprint) throw new Error("Remote listener missing");
    const result = PairingResponse.parse(
      await accessRequest(origin, "/v1/pairings", { token: credential, method: "POST", body: {} }),
    );
    const paired = await redeemPairing(result.url, "Phone");
    const pending = SocketTicket.parse(
      await accessRequest(first.remoteUrl.replace("wss:", "https:"), "/v1/tickets", {
        token: paired.token,
        fingerprint: first.fingerprint,
        method: "POST",
      }),
    );
    await first.close();
    const second = await startDaemon({ config: config });
    cleanups.push(() => second.close());
    if (!second.remoteUrl || !second.fingerprint) throw new Error("Remote listener missing");
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(statSync(join(home, "tls/key.pem")).mode & 0o777).toBe(0o600);
    const fresh = SocketTicket.parse(
      await accessRequest(second.remoteUrl.replace("wss:", "https:"), "/v1/tickets", {
        token: paired.token,
        fingerprint: second.fingerprint,
        method: "POST",
      }),
    );
    const client = new Client(second.url);
    cleanups.push(() => client.close());
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: pending.ticket,
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    const control = new Client(second.url);
    cleanups.push(() => control.close());
    await once(control.socket, "open");
    control.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: fresh.ticket,
    });
    expect(await control.next()).toMatchObject({ type: "welcome" });
  });
});
