import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

type Machines = Awaited<ReturnType<typeof transferMachines>>;

/** A name that must never leave the file system: not in pushes, rows or logs. */
const secretName = "zebra-quartz-credentials.key";

/** A repository whose .gitignore keeps local files, a dependency folder and one secret out. */
async function projectWithIgnoredFiles(root: string, name: string) {
  const { path, origin } = await repositoryWithOrigin(root, name);
  await writeFile(
    join(path, ".gitignore"),
    `.env\nconfig/local.json\nnode_modules/\n${secretName}\ntools/dev.sh\n`,
  );
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "ignore local files");
  await git(path, "push", "origin", "main");
  await writeFile(join(path, ".env"), "TOKEN=here\n", { mode: 0o600 });
  await chmod(join(path, ".env"), 0o600);
  await mkdir(join(path, "config"));
  await writeFile(join(path, "config", "local.json"), '{"port":4000}\n');
  await writeFile(join(path, secretName), "key\n", { mode: 0o600 });
  await chmod(join(path, secretName), 0o600);
  await mkdir(join(path, "tools"));
  await writeFile(join(path, "tools", "dev.sh"), "#!/bin/sh\necho dev\n");
  await chmod(join(path, "tools", "dev.sh"), 0o755);
  await mkdir(join(path, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return { path, origin };
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const outgoingDir = (m: Machines) => join(m.source.h.home, "daemon", "transfers", "outgoing");
const incomingDir = (m: Machines) => join(m.target.h.home, "daemon", "transfers", "incoming");

async function openOn(m: Machines, workspaceId: WorkspaceId, includeIgnored?: boolean) {
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
    ...(includeIgnored === undefined ? {} : { includeIgnored }),
  });
  expect(receipt.ok).toBe(true);
  const started = m.source.daemon.transfers.outgoing
    .list()
    .find((entry) => entry.commandId === receipt.commandId);
  return m.settled(started?.transferId);
}

/** Every log line both daemons wrote, as text. */
async function logs(m: Machines): Promise<string> {
  let text = "";
  for (const home of [m.source.h.home, m.target.h.home]) {
    const directory = join(home, "daemon", "logs");
    for (const name of await readdir(directory).catch(() => []))
      text += await readFile(join(directory, name), "utf8").catch(() => "");
  }
  return text;
}

/** Both machines' transfer rows, as stored. */
function rows(m: Machines): string {
  return JSON.stringify([
    m.source.daemon.store.statement("SELECT * FROM transfer_outgoing").all(),
    m.target.daemon.store.statement("SELECT * FROM transfer_incoming").all(),
  ]);
}

it("brings .env and ignored local config with their modes, but not node_modules", async () => {
  const m = await transferMachines();
  const { path } = await projectWithIgnoredFiles(m.sourceRoot, "app");
  // A commit origin lacks, so the code travels as a bundle beside the ignored files.
  await writeFile(join(path, "feature.txt"), "here only\n");
  await git(path, "add", "feature.txt");
  await git(path, "commit", "-m", "feature");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await openOn(m, workspaceId);
  expect(transfer).toMatchObject({
    phase: "completed",
    ignoredFiles: { files: 4 },
    result: { ignoredSkipped: 0 },
  });
  const there = transfer.result?.path ?? "";
  expect(await readFile(join(there, ".env"), "utf8")).toBe("TOKEN=here\n");
  expect(await mode(join(there, ".env"))).toBe(0o600);
  expect(await mode(join(there, secretName))).toBe(0o600);
  expect(await readFile(join(there, "config", "local.json"), "utf8")).toBe('{"port":4000}\n');
  expect(await mode(join(there, "tools", "dev.sh"))).toBe(0o755);
  await expect(stat(join(there, "node_modules"))).rejects.toThrow();
  // Ignored files arrive ignored there: the checkout reads as clean.
  expect(await git(there, "status", "--porcelain")).toBe("");
  // The byte total counts both payloads, and every byte was sent.
  expect(transfer.sentBytes).toBe(transfer.totalBytes);
  expect(transfer.totalBytes).toBeGreaterThan(transfer.ignoredFiles?.bytes ?? 0);
  // Nothing of either payload is left on either machine.
  expect(await readdir(outgoingDir(m))).toEqual([]);
  expect(await readdir(incomingDir(m))).toEqual([]);
});

it("never names an ignored file in progress, transfer rows or logs", async () => {
  const m = await transferMachines({ logs: true });
  const { path } = await projectWithIgnoredFiles(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await openOn(m, workspaceId);
  expect(transfer.phase).toBe("completed");
  expect(await readFile(join(transfer.result?.path ?? "", secretName), "utf8")).toBe("key\n");
  const logged = await logs(m);
  // The logs did record the transfer, without the names.
  expect(logged).toContain(transfer.transferId);
  for (const text of [JSON.stringify(m.here.messages), rows(m), logged]) {
    expect(text).not.toContain(secretName);
    expect(text).not.toContain("local.json");
    expect(text).not.toContain("dev.sh");
  }
});

it("sends no ignored files with the setting off, or when the transfer says not to", async () => {
  const m = await transferMachines();
  const one = await projectWithIgnoredFiles(m.sourceRoot, "one");
  const two = await projectWithIgnoredFiles(m.sourceRoot, "two");
  const three = await projectWithIgnoredFiles(m.sourceRoot, "three");

  await m.source.daemon.settings.set("remote.transferIgnoredFiles", false, { kind: "global" });
  const off = await openOn(m, await m.addProject(m.source, one.path));
  // The setting is only the default: a transfer that asks for them still brings them.
  const asked = await openOn(m, await m.addProject(m.source, three.path), true);
  await m.source.daemon.settings.set("remote.transferIgnoredFiles", true, { kind: "global" });
  const declined = await openOn(m, await m.addProject(m.source, two.path), false);

  for (const transfer of [off, declined]) {
    expect(transfer.phase).toBe("completed");
    expect(transfer.ignoredFiles).toBeUndefined();
    const there = transfer.result?.path ?? "";
    await expect(stat(join(there, ".env"))).rejects.toThrow();
    await expect(stat(join(there, "config", "local.json"))).rejects.toThrow();
    await expect(stat(join(there, secretName))).rejects.toThrow();
  }
  expect(await readFile(join(asked.result?.path ?? "", ".env"), "utf8")).toBe("TOKEN=here\n");
});

it("keeps the .env a reused project already has there, and says how many it kept", async () => {
  const m = await transferMachines();
  const { path, origin } = await projectWithIgnoredFiles(m.sourceRoot, "app");
  await writeFile(join(path, "extra.local"), "only here\n");
  await writeFile(join(path, ".git", "info", "exclude"), "extra.local\n");
  const existing = join(m.targetRoot, "app");
  await git(m.targetRoot, "clone", `file://${origin}`, existing);
  await writeFile(join(existing, ".env"), "TOKEN=there\n");
  await m.addProject(m.target, existing);
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await openOn(m, workspaceId);
  expect(transfer).toMatchObject({
    phase: "completed",
    method: "remote",
    result: { path: existing, ignoredSkipped: 1 },
  });
  expect(await readFile(join(existing, ".env"), "utf8")).toBe("TOKEN=there\n");
  expect(await readFile(join(existing, "extra.local"), "utf8")).toBe("only here\n");
  expect(await readFile(join(existing, secretName), "utf8")).toBe("key\n");
});

it("removes both payloads on both machines when a transfer is cancelled", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: committing, resolve: committed } = Promise.withResolvers<void>();
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      if (route.method === "POST" && String(route.body).includes('"op":"commit"')) {
        committed();
        await held;
      }
      return inner(profile, route, options);
    },
  });
  const { path } = await projectWithIgnoredFiles(m.sourceRoot, "app");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  // Both payloads are on both machines, waiting for the commit.
  await committing;
  expect((await readdir(outgoingDir(m))).some((name) => name.includes("ignored"))).toBe(true);
  expect((await readdir(incomingDir(m))).some((name) => name.includes("ignored"))).toBe(true);
  const [running] = m.source.daemon.transfers.outgoing.list();
  if (!running) throw new Error("No transfer");
  // The held commit ignores the abort: the cancel answers without waiting for it.
  const answer = await m.here
    .request({ op: "cancel", transferId: running.transferId })
    .finally(release);
  expect(answer).toMatchObject({ kind: "cancelled" });
  expect(m.source.daemon.transfers.outgoing.get(running.transferId)?.transfer.phase).toBe(
    "cancelled",
  );
  await vi.waitFor(async () => {
    expect(await readdir(outgoingDir(m))).toEqual([]);
    expect(await readdir(incomingDir(m))).toEqual([]);
  });
});

it("clears payloads a crash left behind when the daemon starts again", async () => {
  const m = await transferMachines();
  await mkdir(outgoingDir(m), { recursive: true });
  await writeFile(join(outgoingDir(m), "transfer-gone.ignored.tar"), "left behind", {
    mode: 0o600,
  });
  await m.restartSource();
  await vi.waitFor(async () => expect(await readdir(outgoingDir(m))).toEqual([]));
});
