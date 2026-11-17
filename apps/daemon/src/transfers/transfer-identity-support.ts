import { join } from "node:path";
import { vi } from "vitest";
import {
  Command,
  type CommandPayload,
  type ProjectIdentity,
  type WorkspaceId,
} from "@ace/protocol";
import type { TransferTransport } from "./client.ts";
import { git, type Machines } from "./transfer-test-support.ts";

type Side = Machines["source"];

/** Sends the project from the source and waits for that transfer to settle. */
export async function send(m: Machines, workspaceId: WorkspaceId) {
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  if (!receipt.ok) throw new Error(`Refused: ${receipt.error}`);
  const commandId = m.here.lastCommand();
  const transfer = await vi.waitFor(() => {
    const found = m.source.daemon.transfers.outgoing
      .list()
      .find((entry) => entry.commandId === commandId);
    if (!found) throw new Error("Not started yet");
    return found;
  });
  return m.settled(transfer.transferId);
}

/** A registration's logical project on one side. */
export function identityOn(side: Side, workspaceId: string): ProjectIdentity | undefined {
  return side.daemon.projects.catalog.get(workspaceId as WorkspaceId).identity;
}

let sequence = 0;
/** A project command on one side, as the person's window sends it. */
export async function commandOn(side: Side, payload: CommandPayload) {
  const result = await side.daemon.projects.execute(
    Command.parse({ id: `identity-${++sequence}`, deviceId: "window", payload }),
  );
  if (!result.ok) throw new Error(`Refused: ${result.error}`);
  return result;
}

/** A registration an older ace made on one side: no identity of its own. */
export function legacyOn(side: Side, path: string): WorkspaceId {
  return side.daemon.store.createWorkspace(path, path.split("/").at(-1) ?? "project");
}

/** The target's own clone of `origin`, at `name` in its root. */
export async function cloneOn(m: Machines, origin: string, name: string) {
  const path = join(m.targetRoot, name);
  await git(m.targetRoot, "clone", `file://${origin}`, path);
  return path;
}

/**
 * A target from before identity, as the sender sees it: its answers never say `identity`, and,
 * like its strict schemas, it refuses a commit that carries one.
 */
export function olderTarget(calls: Record<string, unknown>[]) {
  return (inner: TransferTransport): TransferTransport =>
    async (profile, route, options) => {
      const body = typeof route.body === "string" ? JSON.parse(route.body) : undefined;
      if (body) calls.push(body);
      if (body?.op === "commit" && "identity" in body)
        throw new Error("older target refused an unknown field");
      const answer = await inner(profile, route, options);
      if (answer && typeof answer === "object" && "identity" in answer) {
        const { identity: _identity, ...rest } = answer as Record<string, unknown>;
        return rest;
      }
      return answer;
    };
}

/** A sender from before identity: its commits never carry one. */
export const olderSender =
  (inner: TransferTransport): TransferTransport =>
  (profile, route, options) => {
    const body = typeof route.body === "string" ? JSON.parse(route.body) : undefined;
    if (body?.op === "commit" && "identity" in body) {
      const { identity: _identity, ...rest } = body;
      return inner(profile, { ...route, body: JSON.stringify(rest) }, options);
    }
    return inner(profile, route, options);
  };
