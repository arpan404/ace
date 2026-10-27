import { expect, test } from "vitest";
import type { AppUpdateReport, ServerMessage } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { token } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>>;

async function next<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

const ready: AppUpdateReport = {
  version: "1.4.1",
  available: "1.4.2",
  downloaded: true,
  restartRequired: true,
  releaseUrl: "https://github.com/arpan404/ace/releases/tag/v1.4.2",
};

test("a headless daemon reads Unknown until the desktop app reports, then every watcher hears it", async () => {
  const f = await setup();
  const device = await f.pair(["read"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "appUpdate.request", requestId: "read" });
  expect(await next(phone, "appUpdate.result")).toEqual({
    type: "appUpdate.result",
    requestId: "read",
    ok: true,
    update: { report: null },
  });

  await accessRequest(f.server.httpUrl, "/v1/app-update", { method: "PUT", token, body: ready });
  expect(await next(phone, "appUpdate.changed")).toEqual({
    type: "appUpdate.changed",
    update: { report: ready },
  });
  // The same report again, as the app sends on reconnect, tells no one.
  await accessRequest(f.server.httpUrl, "/v1/app-update", { method: "PUT", token, body: ready });
  const current = { ...ready, available: null, downloaded: false, restartRequired: false };
  await accessRequest(f.server.httpUrl, "/v1/app-update", { method: "PUT", token, body: current });
  expect(await next(phone, "appUpdate.changed")).toMatchObject({ update: { report: current } });

  // A client that connects later reads the latest report.
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "appUpdate.request", requestId: "late" });
  expect(await next(desk, "appUpdate.result")).toMatchObject({ update: { report: current } });
});

test("only the host token may report, and a malformed report is refused", async () => {
  const f = await setup();
  await expect(
    accessRequest(f.server.httpUrl, "/v1/app-update", { method: "PUT", body: ready }),
  ).rejects.toThrow(/40[13]/);
  await expect(
    accessRequest(f.server.httpUrl, "/v1/app-update", {
      method: "PUT",
      token,
      body: { ...ready, version: "" },
    }),
  ).rejects.toThrow("400");
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "appUpdate.request", requestId: "read" });
  expect(await next(desk, "appUpdate.result")).toMatchObject({ update: { report: null } });
});
