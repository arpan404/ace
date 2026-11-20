import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { z } from "zod";
import { ThreadId, type AgentControlOperation, type AgentControlResult } from "@ace/protocol";
import type { pairedMachines } from "../machines/machine-test-support.ts";

export type Pair = Awaited<ReturnType<typeof pairedMachines>>;
type Side = Pair["source"];

const Delegated = z.object({ threadId: ThreadId });

/** A child of the source's parent thread, delegated to the target ("studio"). */
export async function delegateChild(pair: Pair): Promise<ThreadId> {
  // Listing the machines also tells the source the paths the target serves.
  await pair.source.call({ op: "machines" });
  const answer = await pair.source.call({
    op: "delegate_task",
    requestId: "parcel-child",
    task: "Review the dataset the parent sends",
    role: "Review-dataset",
    provider: "claude",
    machine: "studio",
    project: "project",
  });
  return Delegated.parse(answer.data).threadId;
}

/** An agent tool call made by `threadId`'s own agent on that side. */
export async function callAs(
  side: Side,
  threadId: ThreadId,
  operation: AgentControlOperation,
): Promise<AgentControlResult> {
  let agentId: string | undefined;
  await vi.waitFor(
    () => {
      agentId = side.daemon.store.getThread(threadId)?.rootAgentId;
      if (!agentId) throw new Error("The thread's agent isn't there yet");
    },
    { timeout: 15_000 },
  );
  const thread = side.daemon.store.getThread(threadId);
  if (!thread?.rootAgentId) throw new Error("No agent");
  return (side.daemon.agentControl ?? side.controls).port.execute(
    { sessionId: "test", threadId, agentId: thread.rootAgentId },
    operation,
    new AbortController().signal,
  );
}

/** The thread's working folder on that side, once its session opened. */
export async function folderOf(side: Side, threadId: ThreadId): Promise<string> {
  let folder: string | undefined;
  await vi.waitFor(
    () => {
      const row = side.daemon.store
        .statement("SELECT cwd FROM engine_sessions WHERE thread_id=?")
        .get(threadId);
      if (typeof row?.["cwd"] !== "string") throw new Error("No session yet");
      folder = row["cwd"];
    },
    { timeout: 15_000 },
  );
  if (!folder) throw new Error("No folder");
  return folder;
}

/** A file of random bytes, more than one chunk long, in `folder`. */
export function randomFile(folder: string, name: string, bytes: number) {
  const data = randomBytes(bytes);
  writeFileSync(join(folder, name), data);
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Everything the thread's provider was given on that side. */
export const inputsOf = (side: Side, threadId: ThreadId) =>
  (side.h.inputs.get(threadId) ?? []).join("\n");

/**
 * Waits for the arrival notice of `parcelId` in `threadId` there and reads the copy it names.
 */
export async function arrived(side: Side, threadId: ThreadId, parcelId: string) {
  let notice = "";
  await vi.waitFor(
    () => {
      notice = inputsOf(side, threadId);
      expect(notice).toContain(`Parcel ${parcelId} arrived`);
    },
    { timeout: 30_000 },
  );
  const path = new RegExp(
    `Parcel ${parcelId} arrived[\\s\\S]*?A read-only copy is at (.+?)\\. To keep`,
  ).exec(notice)?.[1];
  if (!path) throw new Error("The notice names no copy");
  return { notice, bytes: readFileSync(path) };
}

/** Waits for the sending thread to hear its parcel was delivered. */
export async function delivered(side: Side, threadId: ThreadId, parcelId: string) {
  await vi.waitFor(
    () =>
      expect(inputsOf(side, threadId)).toMatch(new RegExp(`Parcel ${parcelId} .* was delivered`)),
    { timeout: 30_000 },
  );
}

/**
 * Another address for a machine's listener: a TCP proxy on another port of 127.0.0.1 to `port`,
 * so the same pinned key answers there (reachable on macOS and Linux alike). `hold` keeps what
 * new connections send, their TLS handshakes included, until `release`.
 */
export async function otherAddress(port: number) {
  let holding = false;
  const held: (() => void)[] = [];
  const open = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => open.delete(socket));
    }
    upstream.pipe(client);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    const waiting: Buffer[] = [];
    let passing = !holding;
    if (!passing)
      held.push(() => {
        passing = true;
        for (const chunk of waiting.splice(0)) upstream.write(chunk);
      });
    client.on("data", (chunk: Buffer) => {
      if (passing) upstream.write(chunk);
      else waiting.push(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy not listening");
  return {
    url: `https://127.0.0.1:${address.port}/`,
    hold: () => void (holding = true),
    /** Connections whose bytes are held. */
    held: () => held.length,
    release() {
      holding = false;
      for (const pass of held.splice(0)) pass();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
