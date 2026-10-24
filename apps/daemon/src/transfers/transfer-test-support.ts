import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, vi } from "vitest";
import { validateCloneUrl } from "@ace/git";
import {
  Command,
  DeviceId,
  HostId,
  PairingResponse,
  type CommandPayload,
  type CommandResult,
  type DeviceScope,
  type ServerMessage,
  type Transfer,
  type TransfersRequest,
  type WorkspaceId,
} from "@ace/protocol";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { accessRequest, redeemPairing } from "../client-access.ts";
import { Profiles } from "../cli/profiles.ts";
import { loadHostId } from "../local-files.ts";
import { Client } from "../socket-test-support.ts";
import type { TransferTransport } from "./client.ts";
import { transferTransport } from "./client.ts";

const run = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
}, 60_000);

/** Clones of a local bare repository stand in for origin; only tests may use file URLs. */
const fixturePolicy = {
  validateUrl(value: string) {
    if (value.startsWith("file://") || value.startsWith("/")) return;
    // Local HTTP servers exercise authentication and stalled transports without TLS fixtures.
    validateCloneUrl(value.replace(/^http:\/\/(127\.0\.0\.1:\d+)\//, "https://$1/"));
  },
  protocols: ["file", "http", "https", "ssh"],
};

/** Git as the person runs it in the fixtures, with a fixed identity. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return stdout.trimEnd();
}

/** A repository with a bare `origin` holding its first commit on `main`. */
export async function repositoryWithOrigin(root: string, name: string) {
  const origin = join(root, `${name}-origin.git`);
  const path = join(root, name);
  await run("git", ["init", "--bare", "-b", "main", origin]);
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "README.md"), "hello\n");
  await writeFile(join(path, "gone.txt"), "to delete\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "first");
  await git(path, "remote", "add", "origin", `file://${origin}`);
  await git(path, "push", "-u", "origin", "main");
  return { path, origin };
}

/** The machine's own app window: its socket, signed in with the host token. */
async function window(daemon: { url: string; tokenPath: string }) {
  const client = new Client(daemon.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("window"),
    token: readFileSync(daemon.tokenPath, "utf8").trim(),
  });
  const messages: ServerMessage[] = [];
  const welcome = await client.next();
  if (welcome.type !== "welcome") throw new Error("Not welcomed");
  void (async () => {
    for (;;) messages.push(await client.next());
  })().catch(() => undefined);
  let sequence = 0;
  async function command(payload: CommandPayload): Promise<CommandResult> {
    const id = `command-${++sequence}`;
    client.send({ type: "command", command: Command.parse({ id, deviceId: "window", payload }) });
    return vi.waitFor(
      () => {
        const found = messages.find(
          (message) => message.type === "commandResult" && message.commandId === id,
        );
        if (found?.type !== "commandResult") throw new Error("No receipt yet");
        return found;
      },
      { timeout: 30_000, interval: 20 },
    );
  }
  async function request(operation: TransfersRequest["operation"]) {
    const requestId = `transfers-${++sequence}`;
    client.send({ type: "transfers.request", requestId, operation });
    return vi.waitFor(
      () => {
        const found = messages.find(
          (message) => message.type === "transfers.result" && message.requestId === requestId,
        );
        if (found?.type !== "transfers.result") throw new Error("No answer yet");
        return found.result;
      },
      { timeout: 30_000, interval: 20 },
    );
  }
  async function links() {
    const requestId = `fleet-${++sequence}`;
    client.send({ type: "fleet.request", requestId, operation: { op: "links" } });
    return vi.waitFor(
      () => {
        const found = messages.find(
          (message) => message.type === "fleet.result" && message.requestId === requestId,
        );
        if (found?.type !== "fleet.result" || found.result.kind !== "links")
          throw new Error("No links yet");
        return found.result.links;
      },
      { timeout: 30_000, interval: 20 },
    );
  }
  /** Every `transfer.progress` push this window got for one transfer, in order. */
  const progress = (commandId?: string): Transfer[] =>
    messages.flatMap((message) =>
      message.type === "transfer.progress" &&
      (commandId === undefined || message.transfer.commandId === commandId)
        ? [message.transfer]
        : [],
    );
  return { command, request, links, progress, messages, lastCommand: () => `command-${sequence}` };
}

/** Polls and retries wait 20 ms in tests instead of up to 30 s. */
const quickSleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Each machine may make projects only in its own root folder. */
const projects = (root: string) => ({
  home: root,
  roots: async () => [root],
  gitPolicy: fixturePolicy,
});

type Side = Awaited<ReturnType<typeof daemonFixture>>;

/** The paths of a daemon's registered projects. */
export function registered(side: Side): string[] {
  return side.daemon.store
    .statement(
      "SELECT path FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY path",
    )
    .all()
    .map((row) => String(row["path"]));
}

/**
 * Two real daemons in temp homes, the target listening for paired devices over TLS and the
 * source paired with it as `ace remote add` stores a machine (profile `studio`). Each may make
 * projects only in its own root folder.
 */
export async function transferMachines(
  options: {
    scopes?: DeviceScope[];
    cloneTimeoutMs?: number;
    /** Wraps the source's transfer transport, e.g. to drop a connection. */
    transport?: (inner: TransferTransport) => TransferTransport;
  } = {},
) {
  const sourceRoot = await realpath(await mkdtemp(join(tmpdir(), "ace-transfer-source-")));
  const targetRoot = await realpath(await mkdtemp(join(tmpdir(), "ace-transfer-target-")));
  cleanup.push(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });
  const target = await daemonFixture(
    undefined,
    {
      projects: projects(targetRoot),
      transfers: options.cloneTimeoutMs ? { cloneTimeoutMs: options.cloneTimeoutMs } : {},
    },
    { ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  cleanup.push(() => target.daemon.close());
  const transport = options.transport ? options.transport(transferTransport) : transferTransport;
  const sourceOptions = {
    projects: projects(sourceRoot),
    transfers: { transport, sleep: quickSleep, offlineMs: 5_000 },
  };
  let source: Side = await daemonFixture(undefined, sourceOptions);
  cleanup.push(() => source.daemon.close());
  const { remoteUrl, fingerprint } = target.daemon;
  if (!remoteUrl || !fingerprint) throw new Error("Target is not listening for paired devices");
  const targetHome = join(target.h.home, "daemon");
  const pairing = PairingResponse.parse(
    await accessRequest(readFileSync(join(targetHome, "daemon-endpoint"), "utf8"), "/v1/pairings", {
      method: "POST",
      token: readFileSync(target.daemon.tokenPath, "utf8"),
      body: { scopes: options.scopes ?? ["read", "operate", "projects"] },
    }),
  );
  const credential = await redeemPairing(pairing.url, "MacBook");
  const profiles = new Profiles(join(source.h.home, "daemon"));
  profiles.add({
    name: "studio",
    origin: `${remoteUrl.replace("wss:", "https:").replace(/\/?$/, "/")}`,
    fingerprint,
    deviceId: credential.device.id,
    token: credential.token,
  });
  profiles.close();
  await target.daemon.settings.set("host.displayName", "Studio", { kind: "global" });
  await source.daemon.settings.set("host.displayName", "MacBook", { kind: "global" });
  const targetHostId = HostId.parse(loadHostId(targetHome));
  let here = await window(source.daemon);

  /** Registers a folder as a project on one side, as Add project does. */
  async function addProject(side: Side, path: string): Promise<WorkspaceId> {
    const result = await side.daemon.projects.execute(
      Command.parse({
        id: `add-${path}`,
        deviceId: "window",
        payload: { type: "workspace.add", path },
      }),
    );
    if (!result.ok || !result.workspace) throw new Error(`Not added: ${result.error}`);
    return result.workspace.id;
  }
  /** Waits for a transfer, as the source lists it, to settle. */
  async function settled(transferId?: string): Promise<Transfer> {
    return vi.waitFor(
      () => {
        const transfers = source.daemon.transfers.outgoing.list();
        const found = transferId
          ? transfers.find((entry) => entry.transferId === transferId)
          : transfers[0];
        if (!found || !["completed", "failed", "cancelled"].includes(found.phase))
          throw new Error(`Still ${found?.phase ?? "missing"}`);
        return found;
      },
      { timeout: 60_000, interval: 50 },
    );
  }
  /** Stops the source daemon and starts it again on the same home. */
  async function restartSource(wrap?: (inner: TransferTransport) => TransferTransport) {
    await source.daemon.close();
    const next = {
      ...sourceOptions,
      transfers: {
        ...sourceOptions.transfers,
        transport: wrap ? wrap(transferTransport) : transferTransport,
      },
    };
    source = await daemonFixture(undefined, next, {}, source.h);
    cleanup.push(() => source.daemon.close());
    here = await window(source.daemon);
  }
  return {
    get source() {
      return source;
    },
    target,
    sourceRoot,
    targetRoot,
    targetHostId,
    get here() {
      return here;
    },
    addProject,
    settled,
    restartSource,
  };
}
