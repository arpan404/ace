import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { DeviceId, type AutomationRequest } from "@ace/protocol";
import type { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { Client } from "./socket-test-support.ts";

/** A signed-in app connection that sends automation requests and reads their replies. */
export async function connectAutomations(
  f: Awaited<ReturnType<typeof daemonFixture>>,
  device: string,
) {
  const client = new Client(f.daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(device),
    token: await readFile(join(f.h.home, "daemon", "daemon-token"), "utf8"),
  });
  expect((await client.next()).type).toBe("welcome");
  return {
    client,
    async ask(request: AutomationRequest) {
      client.send(request);
      for (;;) {
        const response = await client.next();
        if (response.type === "automation.result" && response.requestId === request.requestId)
          return response;
      }
    },
  };
}
