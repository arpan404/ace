import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
const code: InstalledEditor = { id: "code", name: "Visual Studio Code", command: "/bin/code" };
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

/**
 * A daemon with a project, a personal skills folder and an unrelated folder, the machine's own
 * connection (the owner) and a phone paired with operate access.
 */
async function machine() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-host-scope-")));
  folders.push(home);
  const project = join(home, "app");
  const skills = join(home, ".agents", "skills");
  for (const dir of [project, join(skills, "review"), join(home, "Documents")])
    await mkdir(dir, { recursive: true });
  await writeFile(join(project, "main.ts"), "export {};\n");
  await writeFile(join(skills, "review", "SKILL.md"), "# Review\n");
  await writeFile(join(home, "Documents", "taxes.txt"), "private\n");
  const started: HostLaunch[] = [];
  const f = await setup({}, (store, dataHome) => ({
    workspaceActions: new WorkspaceRuntime(store, join(dataHome, "workspace"), () => 1000, {
      platform: "darwin",
      home,
      hostSkillRoots: () => [skills],
      hostEditors: async () => [code],
      hostSpawn: async (launch) => {
        started.push(launch);
      },
    }),
  }));
  WorkspaceId.parse(f.store.createWorkspace(project, "App"));
  const owner = await f.connect();
  expect(await owner.next()).toMatchObject({ type: "welcome" });
  owner.send({
    type: "fleet.request",
    requestId: "pair",
    operation: { op: "pairing", scopes: ["read", "operate"], deviceTtlMs: day },
  });
  const issued = await answer(owner, "pair");
  if (issued.type !== "fleet.result" || issued.result.kind !== "pairing")
    throw new Error("no pairing");
  const credential = await redeemPairing(issued.result.url, "Phone");
  const ticket = await f.ticket(credential.token);
  const phone = await f.connectTicket(credential.device.id, ticket.ticket);
  expect(await phone.next()).toMatchObject({ type: "welcome" });
  const open = async (client: Client, requestId: string, hostPath: string) => {
    client.send({
      type: "workspace.request",
      requestId,
      operation: { op: "host.open", app: { kind: "editor", editorId: "code" }, hostPath },
    });
    const reply = await answer(client, requestId);
    return reply.type === "workspace.result" ? reply.result : undefined;
  };
  return { home, project, skills, owner, phone, open, started };
}

/** The reply to `requestId`, skipping unrelated pushes. */
async function answer(client: Client, requestId: string): Promise<ServerMessage> {
  for (;;) {
    const message: ServerMessage = await client.next();
    if ("requestId" in message && message.requestId === requestId) return message;
  }
}

it("a phone with operate access opens files in projects and personal skills by path", async () => {
  const at = await machine();
  expect(await at.open(at.phone, "project", join(at.project, "main.ts"))).toEqual({
    kind: "opened",
  });
  expect(await at.open(at.phone, "skill", "~/.agents/skills/review/SKILL.md")).toEqual({
    kind: "opened",
  });
  expect(at.started.map((launch) => launch.args)).toEqual([
    [join(at.project, "main.ts")],
    [join(at.skills, "review", "SKILL.md")],
  ]);
});

it("only the machine's owner opens a file outside every project", async () => {
  const at = await machine();
  expect(await at.open(at.phone, "phone", "~/Documents/taxes.txt")).toEqual({
    kind: "error",
    code: "owner_only",
  });
  expect(at.started).toEqual([]);
  expect(await at.open(at.owner, "owner", "~/Documents/taxes.txt")).toEqual({ kind: "opened" });
  expect(at.started.map((launch) => launch.args)).toEqual([
    [join(at.home, "Documents", "taxes.txt")],
  ]);
});

it("a missing path and a device file are refused by their own codes", async () => {
  const at = await machine();
  expect(await at.open(at.owner, "missing", join(at.project, "gone.ts"))).toEqual({
    kind: "error",
    code: "path_not_found",
  });
  if (process.platform !== "win32")
    expect(await at.open(at.owner, "device", "/dev/null")).toEqual({
      kind: "error",
      code: "path_not_openable",
    });
  expect(at.started).toEqual([]);
});
