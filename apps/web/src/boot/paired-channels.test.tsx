import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { ClientMessage, SocketTicket } from "@ace/protocol";
import { fakeClient } from "@/test/harness.tsx";
import { useDeviceSession } from "@/features/devices/device-session.ts";
import { useScreenSession } from "@/features/computer-use/screen-session.ts";
import { DaemonConnectionContext, fallback, type DaemonEndpoint } from "./connection.tsx";

afterEach(() => vi.unstubAllGlobals());

test("a paired browser opens devices and computer use with independent one-use tickets", async () => {
  const tickets = new Set<string>();
  let sequence = 0;
  vi.stubGlobal("fetch", async () => {
    const ticket = (++sequence).toString(16).padStart(64, "0");
    tickets.add(ticket);
    return Response.json(SocketTicket.parse({ ticket, expiresAt: 100000 }));
  });
  class Socket extends EventTarget {
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(value: string) {
      const frame = ClientMessage.parse(JSON.parse(value));
      if (frame.type === "hello") {
        if (!frame.ticket || !tickets.delete(frame.ticket)) {
          this.close();
          return;
        }
        this.deliver({ type: "welcome", protocolVersion: 1, hostId: "office", headSeq: 0 });
      } else if (frame.type === "devices.request")
        this.deliver({
          type: "devices.result",
          requestId: frame.requestId,
          ok: true,
          devices: [],
          issues: [],
        });
      else if (frame.type === "screen.request")
        this.deliver({
          type: "screen.result",
          requestId: frame.requestId,
          ok: false,
          error: "screen_disabled",
        });
    }
    deliver(value: unknown) {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })),
      );
    }
    close() {
      this.dispatchEvent(new CloseEvent("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const endpoint: DaemonEndpoint = {
    kind: "daemon",
    deviceId: "paired",
    target: { url: "wss://office.test/", token: "a".repeat(64), pairedDeviceId: "paired" },
  };
  const client = fakeClient(new FakeDaemon({ clock: () => 1000 }));
  await client.start();
  function Channels() {
    const devices = useDeviceSession(endpoint);
    const computer = useScreenSession();
    return (
      <>
        <p>{devices.snapshot.connected ? "Devices connected" : "Devices offline"}</p>
        <p>{computer.snapshot.connected ? "Computer use connected" : "Computer use offline"}</p>
      </>
    );
  }
  const connection = Object.freeze({ ...fallback, endpoint });
  render(
    <ClientProvider client={client}>
      <DaemonConnectionContext.Provider value={connection}>
        <Channels />
      </DaemonConnectionContext.Provider>
    </ClientProvider>,
  );
  expect(await screen.findByText("Devices connected")).toBeTruthy();
  expect(await screen.findByText("Computer use connected")).toBeTruthy();
  expect(tickets.size).toBe(0);
});
