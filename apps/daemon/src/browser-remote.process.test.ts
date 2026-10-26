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
    expect(
      await phone.request({
        type: "browser.subscribe",
        requestId: "watch",
        threadId: f.thread.id,
        binaryFrames: true,
        viewport: { width: 390, height: 600, devicePixelRatio: 3 },
        video: { codecs: ["avc1.42E033", "vp8"] },
      }),
    ).toMatchObject({ ok: true });
    // The phone watches the live view as video, starting at a keyframe.
    const delivered = await phone.nextStream((message) =>
      message.kind === "browser.video" && message.threadId === f.thread.id
        ? message.chunk
        : undefined,
    );
    expect(delivered.key).toBe(true);
    expect(delivered.bytes.length).toBeGreaterThan(0);
    phone.send({
      type: "browser.ack",
      requestId: "ack",
      threadId: f.thread.id,
      sequence: delivered.sequence,
      video: true,
    });
    expect(
      await phone.request({
        type: "browser.tabs.private",
        requestId: "denied",
        threadId: f.thread.id,
        tabId: browser.state(f.thread.id).activeTabId ?? "page",
        private: true,
      }),
    ).toMatchObject({ ok: false });
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
    // A request on the surviving viewer synchronizes after the closed operator's
    // socket cleanup; the viewer keeps watching.
    await phone.request({
      type: "browser.execute",
      requestId: "after-close",
      threadId: f.thread.id,
      command: { action: "snapshot" },
    });
  }, 60_000);
});
