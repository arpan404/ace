import { expect, it, onTestFinished } from "vitest";
import { DeviceId } from "@ace/protocol";
import { ticketCredential } from "./index.ts";
import { ScreenClient } from "./screen.ts";
import { ready, setup } from "./test-support.ts";

it.each(["screen_disabled", "forbidden"] as const)(
  "screen requests reject promptly with %s without advancing the timeout clock",
  async (code) => {
    const f = await setup();
    onTestFinished(f.cleanup);
    const paired = f.daemon.store.devices.create("Phone", ["read", "operate"], 1);
    const { client } = f.make(
      code === "forbidden"
        ? {
            deviceId: DeviceId.parse(paired.device.id),
            credential: ticketCredential(
              async () => paired.token,
              async (token) => {
                const response = await fetch(f.daemon.url.replace("ws:", "http:") + "/v1/tickets", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok) throw new Error("Ticket refused");
                return response.json();
              },
            ),
          }
        : {},
    );
    await ready(client);
    const screen = new ScreenClient(client);
    await expect(screen.sessions()).rejects.toMatchObject({ errorCode: code });
    await expect(screen.requestPermission("accessibility")).rejects.toMatchObject({
      errorCode: code,
    });
  },
);
