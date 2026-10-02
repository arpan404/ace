import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserService, detectChromium } from "@ace/browser";
import { BrowserClient } from "./browser-test-client.ts";
import { token } from "./socket-test-support.ts";
import { pinnedAgent } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";

const executablePath = await detectChromium();
describe.skipIf(!executablePath)("paired remote browser clients", () => {
  it("lets a read-only phone watch over pinned WSS while only an operator can control", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-remote-"));
    const browser = new BrowserService({
      dataDir: home,
      ...(executablePath ? { executablePath } : {}),
    });
    cleanups.push(async () => {
      await browser.close();
      await rm(home, { recursive: true, force: true });
    });
    const f = await setup({ browser });
    await browser.open({ threadId: f.thread.id, workspaceId: f.thread.workspaceId });
    const connect = async (scopes: string[]) => {
      const paired = await f.pair(scopes);
      const ticket = await f.ticket(paired.token);
      const client = new BrowserClient(f.server.remoteUrl, {
        agent: pinnedAgent(identity.fingerprint),
      });
      cleanups.push(() => client.close());
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: paired.device.id,
        ticket: ticket.ticket,
      });
      await client.next((message) => message.type === "welcome");
      return { client, deviceId: paired.device.id };
    };
    const { client: phone } = await connect(["read"]);
    const frame = phone.next((message) => message.type === "browser.frame");
    expect(
      await phone.request({ type: "browser.subscribe", requestId: "watch", threadId: f.thread.id }),
    ).toMatchObject({ ok: true });
    const delivered = await frame;
    if (delivered.type !== "browser.frame") throw new Error("No remote JPEG");
    expect(Buffer.from(delivered.frame.data, "base64").subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    );
    phone.send({
      type: "browser.ack",
      requestId: "ack",
      threadId: f.thread.id,
      sequence: delivered.frame.sequence,
    });
    expect(
      await phone.request({ type: "browser.takeover", requestId: "denied", threadId: f.thread.id }),
    ).toMatchObject({ ok: false });
    expect(browser.state(f.thread.id).controller).toBe("agent");
    expect(
      await phone.request({
        type: "browser.execute",
        requestId: "inspect",
        threadId: f.thread.id,
        command: { action: "snapshot" },
      }),
    ).toMatchObject({ ok: true });
    const { client: operator, deviceId: operatorDevice } = await connect(["operate"]);
    expect(
      await operator.request({
        type: "browser.subscribe",
        requestId: "no-read",
        threadId: f.thread.id,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await operator.request({
        type: "browser.takeover",
        requestId: "take",
        threadId: f.thread.id,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await operator.request({
        type: "browser.execute",
        requestId: "resize",
        threadId: f.thread.id,
        command: { action: "resize", width: 640, height: 480 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await phone.request({
        type: "browser.execute",
        requestId: "no-write",
        threadId: f.thread.id,
        command: { action: "resize", width: 800, height: 600 },
      }),
    ).toMatchObject({ ok: false });
    const disconnected = once(operator.socket, "close");
    expect(await f.request(`/v1/devices/${operatorDevice}`, { method: "DELETE", token })).toEqual({
      revoked: true,
    });
    await disconnected;
    // A request on the surviving viewer synchronizes after the closed owner's
    // socket cleanup; it receives the resulting controller state.
    await phone.request({
      type: "browser.execute",
      requestId: "after-close",
      threadId: f.thread.id,
      command: { action: "snapshot" },
    });
    expect(browser.state(f.thread.id).controller).toBe("agent");
  }, 60_000);
});
