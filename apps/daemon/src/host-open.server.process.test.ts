import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceId, type InstalledEditor, type ServerMessage } from "@ace/protocol";
import { redeemPairing } from "./client-access.ts";
import type { HostLaunch } from "./host-open.ts";
import { setup } from "./remote-test-support.ts";
import type { Client } from "./socket-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const day = 24 * 60 * 60_000;
const noop = () => {};
const code: InstalledEditor = { id: "code", name: "Visual Studio Code", command: "/bin/code" };
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

/**
 * A daemon whose editor discovery waits for the test, and a phone paired with operate access
 * for one day, connected over the socket.
 */
async function machine() {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ace-host-open-project-")));
  folders.push(project);
  const started: HostLaunch[] = [];
  let finish: (editors: InstalledEditor[]) => void = noop;
  const f = await setup({}, (store, home) => ({
    workspaceActions: new WorkspaceRuntime(store, join(home, "workspace"), () => 1000, {
      platform: "darwin",
      hostEditors: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      hostSpawn: async (launch) => {
        started.push(launch);
      },
    }),
  }));
  const workspaceId = WorkspaceId.parse(f.store.createWorkspace(project, "Project"));
  const host = await f.connect();
  expect(await host.next()).toMatchObject({ type: "welcome" });
  host.send({
    type: "fleet.request",
    requestId: "pair",
    operation: { op: "pairing", scopes: ["read", "operate"], deviceTtlMs: day },
  });
  const issued = await answer(host, "pair");
  if (issued.type !== "fleet.result" || issued.result.kind !== "pairing")
    throw new Error("no pairing");
  const credential = await redeemPairing(issued.result.url, "Phone");
  const ticket = await f.ticket(credential.token);
  const phone = await f.connectTicket(credential.device.id, ticket.ticket);
  expect(await phone.next()).toMatchObject({ type: "welcome" });
  const open = (requestId: string) =>
    phone.send({
      type: "workspace.request",
      requestId,
      operation: { op: "host.open", app: { kind: "editor", editorId: "code" }, workspaceId },
    });
  return { f, phone, open, started, finish: () => finish([code]) };
}

/** The reply to `requestId`, skipping unrelated pushes. */
async function answer(client: Client, requestId: string): Promise<ServerMessage> {
  for (;;) {
    const message: ServerMessage = await client.next();
    if ("requestId" in message && message.requestId === requestId) return message;
  }
}

it("a phone whose access expires while editors are found never starts the editor", async () => {
  const { f, phone, open, started, finish } = await machine();
  open("expiring");
  // The open is waiting on discovery; the phone's day runs out meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 50));
  f.advance(day + 1);
  finish();
  const reply = await answer(phone, "expiring");
  expect(reply).toMatchObject({
    type: "workspace.result",
    result: { kind: "error", code: "forbidden" },
  });
  expect(started).toEqual([]);
});

it("a phone still within its access opens the editor on the machine", async () => {
  const { phone, open, started, finish } = await machine();
  open("current");
  await new Promise((resolve) => setTimeout(resolve, 50));
  finish();
  expect(await answer(phone, "current")).toMatchObject({ result: { kind: "opened" } });
  expect(started).toHaveLength(1);
});
