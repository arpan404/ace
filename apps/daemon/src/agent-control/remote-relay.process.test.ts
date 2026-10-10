import { returnRemoteArtifacts } from "@ace/client-worker/remote-artifact-return";
import { RemoteReturns, remoteReturnTransfer } from "./remote-return.ts";
import { RemoteArtifactManifest } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { organizeThread } from "../thread-organization.ts";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { keyPair, fingerprint } from "@ace/secure-channel";
import { type ServiceRequest, type ServiceResponse } from "@ace/client";
import {
  Command,
  RemoteAgentHost,
  RemoteAgentOperation,
  RemoteTask,
  RemoteDelegationResult,
  DeviceId,
  ClientMessage,
  ContextResult,
  ContextRequest,
} from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";
import { Client } from "../socket-test-support.ts";
import { RemoteAuth } from "../remote-auth.ts";
import { startFilesRelay } from "../files-relay.ts";
import { remoteContextTransfer, incomingRemoteContext } from "./remote-context-transfer.ts";
import { remoteContextOwner } from "./remote-identity.ts";
import { transferRemoteContext } from "@ace/client-worker/remote-context-transfer";
import type { ServerOptions } from "../server-options.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
  "base64",
);
async function open(f: Awaited<ReturnType<typeof daemonFixture>>, device: string) {
  const client = new Client(f.daemon.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(device),
    token: await readFile(f.daemon.tokenPath, "utf8"),
  });
  const welcome = await client.next();
  if (welcome.type !== "welcome") throw new Error("Expected welcome");
  let sequence = 0;
  async function request<Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> {
    const requestId = `request-${++sequence}`;
    client.send(ClientMessage.parse({ ...input, requestId }));
    for (;;) {
      const reply = await client.next();
      if ("requestId" in reply && reply.requestId === requestId) return reply as ServiceResponse<Q>;
    }
  }
  return { client, request, hostId: welcome.hostId };
}
async function world() {
  const source = await daemonFixture();
  cleanup.push(() => source.daemon.close());
  const target = await daemonFixture();
  cleanup.push(() => target.daemon.close());
  const sourceWire = await open(source, "source-client");
  const targetWire = await open(target, "broker-one");
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const targetOptions: ServerOptions = {
    store: target.daemon.store,
    context: target.daemon.context,
    hostId: targetWire.hostId,
    port: 0,
    token: "unused",
    agentControl: target.controls,
    engine: target.daemon.engine!,
    handler: target.daemon.engine!.handler,
  };
  const sourceOptions: ServerOptions = {
    store: source.daemon.store,
    context: source.daemon.context,
    hostId: sourceWire.hostId,
    port: 0,
    token: "unused",
    agentControl: source.controls,
    handler: source.daemon.engine!.handler,
  };
  const auth = new RemoteAuth(target.daemon.store.devices, "unused-host-token", {
    now: Date.now,
    secret: randomUUID,
  });
  const credential = auth.redeem(auth.pairing(["admin"]).code, "Context broker");
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    auth,
    devices: target.daemon.store.devices,
    store: target.daemon.store,
    context: target.daemon.context,
    remoteDelegation: targetOptions,
    hostId: targetWire.hostId,
    headSeq: () => target.daemon.store.headSeq(),
  });
  cleanup.push(() => host.close());
  const safe = source.daemon.engine!.permissionMode(source.caller.threadId) ?? ":read-only";
  const lease = source.controls.remote.register(
    "broker",
    [
      RemoteAgentHost.parse({
        hostId: targetWire.hostId,
        name: "Target",
        projects: [{ workspaceId: target.workspace, name: "Target project" }],
        agents: [
          {
            provider: "codex",
            model: "chosen-model",
            accountId: "codex-cli-default",
            permissionModes: [{ id: safe, label: "Safe", description: "safe", risk: "low" }],
          },
        ],
      }),
    ],
    () => true,
  )!;
  async function relayChannel() {
    const channel = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
    });
    cleanup.push(async () => {
      channel.close();
      await channel.closed;
    });
    await channel.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: credential.device.id,
      token: credential.token,
      channel: "files",
    });
    expect(await channel.receive()).toMatchObject({ type: "welcome", hostId: targetWire.hostId });
    return {
      async request(
        message: Extract<
          import("@ace/protocol").ClientMessage,
          { type: "delegation.remote.context" | "delegation.remote.output" }
        >,
      ) {
        await channel.send(message);
        return RemoteDelegationResult.parse(await channel.receive());
      },
      close: () => channel.close(),
    };
  }
  async function sourceRequest<Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> {
    if (input.type === "delegation.broker.return") {
      const parsed = ClientMessage.parse({ ...input, requestId: randomUUID() });
      if (parsed.type !== "delegation.broker.return") throw new Error("Bad return input");
      return (await remoteReturnTransfer(
        sourceOptions,
        parsed,
        "broker",
        () => true,
      )) as ServiceResponse<Q>;
    }
    if (input.type !== "delegation.remote.context") throw new Error("Unexpected source request");
    return (await remoteContextTransfer(
      sourceOptions,
      ClientMessage.parse({ ...input, requestId: randomUUID() }) as Extract<
        import("@ace/protocol").ClientMessage,
        { type: "delegation.remote.context" }
      >,
      () => true,
    )) as ServiceResponse<Q>;
  }
  async function targetRequest<Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> {
    if (input.type === "delegation.remote.transport")
      return RemoteDelegationResult.parse({
        type: "delegation.broker.result",
        requestId: "route",
        ok: true,
        relay: { url: relay.url, pinnedFingerprint: fingerprint(keys.publicKey) },
      }) as ServiceResponse<Q>;
    return targetWire.request(input);
  }
  async function delegate(
    context?: { attachments?: string[]; files?: string[] },
    requestId = "work",
  ) {
    const reply = await source.controls.remote.execute(
      source.caller,
      RemoteAgentOperation.parse({
        op: "device.delegate",
        requestId,
        provider: "codex",
        model: "chosen-model",
        accountId: "codex-cli-default",
        hostId: targetWire.hostId,
        workspaceId: target.workspace,
        mode: "local",
        role: "Review",
        task: "Inspect the supplied context",
        ...(context ? { context } : {}),
      }),
      new AbortController().signal,
    );
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    return RemoteTask.parse(reply.data);
  }
  async function put(bytes: Buffer, name: string) {
    const context = source.daemon.context;
    const begun = await context.uploads.handle("source", {
      op: "upload.begin",
      threadId: source.caller.threadId,
      sha256: hash(bytes),
      bytes: bytes.length,
      name,
    });
    if (begun.kind !== "upload") throw new Error("Expected upload");
    await context.uploads.handle("source", {
      op: "upload.chunk",
      uploadId: begun.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    });
    const committed = await context.uploads.handle("source", {
      op: "upload.commit",
      uploadId: begun.uploadId,
    });
    if (committed.kind !== "attachment") throw new Error("Expected attachment");
    return committed.attachment;
  }
  return {
    source,
    target,
    sourceWire,
    targetWire,
    sourceOptions,
    targetOptions,
    relay,
    auth,
    credential,
    lease,
    relayChannel,
    sourceRequest,
    targetRequest,
    delegate,
    put,
  };
}

test("two devices transfer image bytes, immutable workspace file and thread provenance through encrypted relay before admission", async () => {
  const f = await world();
  const image = await f.put(png, "reference.png");
  await writeFile(join(f.source.h.home, "notes.txt"), "Frozen source file\n");
  const task = await f.delegate({ attachments: [image.sha256], files: ["notes.txt"] });
  expect(task.context).toMatchObject({
    sourceHostId: f.sourceWire.hostId,
    sourceThreadId: f.source.caller.threadId,
    summary: expect.stringContaining("plan"),
    attachments: [{ sha256: image.sha256 }, { sourcePath: "notes.txt" }],
  });
  await writeFile(join(f.source.h.home, "notes.txt"), "Changed later");
  f.source.controls.remote.poll("broker", f.lease);
  expect(await f.targetWire.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: false,
    error: "not_ready",
  });
  await transferRemoteContext(
    task,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  const projected = incomingRemoteContext(f.targetOptions, task);
  expect(projected?.attachments).toHaveLength(2);
  const start = await f.targetWire.request({ type: "delegation.remote.start", task });
  expect(start).toMatchObject({ ok: true });
  await f.target.daemon.engine!.flush();
  const thread = f.target.daemon.store.getThread(task.threadId);
  expect(thread).toBeDefined();
  const read = await f.target.daemon.context.readAttachment(
    remoteContextOwner,
    task.threadId,
    image.sha256,
    "original",
    0,
    65536,
  );
  expect(read.data).toEqual(png);
  const file = task.context!.attachments.find(
    (attachment) => attachment.sourcePath === "notes.txt",
  )!;
  expect(
    (
      await f.target.daemon.context.readAttachment(
        remoteContextOwner,
        task.threadId,
        file.sha256,
        "original",
        0,
        65536,
      )
    ).data.toString(),
  ).toBe("Frozen source file\n");
  const replacement = await open(f.target, "broker-two");
  expect(await replacement.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: true,
  });
  expect(
    f.target.daemon.store.listThreads().filter((candidate) => candidate.id === task.threadId),
  ).toHaveLength(1);
  expect(
    await replacement.request({ type: "delegation.remote.status", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "completed" });
  const page = f.target.daemon.store.readItemPage(
    task.threadId,
    f.target.daemon.store.headSeq() + 1,
    20,
    32768,
  );
  expect(
    page.items.some(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text.includes(f.sourceWire.hostId)),
    ),
  ).toBe(true);
});

test("scope, cancellation fence and disconnected relay never start a task or expose another attachment", async () => {
  const f = await world();
  const file = await f.put(Buffer.from("private context"), "context.txt");
  const task = await f.delegate({ attachments: [file.sha256] });
  const channel = await f.relayChannel();
  expect(
    await channel.request({
      type: "delegation.remote.context",
      requestId: "other",
      task,
      operation: { op: "read", sha256: file.sha256, offset: 0 },
    }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  expect(
    await f.sourceRequest({
      type: "delegation.remote.context",
      task,
      operation: { op: "read", sha256: "0".repeat(64), offset: 0 },
    }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  expect(
    await f.targetWire.request({ type: "delegation.remote.cancel", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "cancelled" });
  expect(
    await channel.request({
      type: "delegation.remote.context",
      requestId: "fenced",
      task,
      operation: { op: "prepare" },
    }),
  ).toMatchObject({ ok: false, error: "invalid" });
  expect(await f.targetWire.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: false,
  });
  expect(f.target.daemon.store.getThread(task.threadId)).toBeUndefined();
  await f.relay.close();
  await expect(
    transferRemoteContext(
      task,
      { request: f.sourceRequest },
      { request: f.targetRequest },
      f.relayChannel,
      () => true,
    ),
  ).rejects.toThrow();
  expect(f.target.daemon.store.getThread(task.threadId)).toBeUndefined();
});

test("text context uses relay; transient target stop retries and deleted admitted tasks settle", async () => {
  const f = await world();
  const task = await f.delegate();
  expect(await f.targetWire.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: false,
    error: "not_ready",
  });
  await transferRemoteContext(
    task,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  expect(await f.targetWire.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: true,
  });
  await f.target.daemon.engine!.flush();
  const handler = vi.spyOn(f.target.daemon.engine!.internalHandler, "handle");
  handler.mockImplementationOnce((command) => ({
    commandId: command.id,
    ok: false,
    error: "engine_starting",
  }));
  expect(
    await f.targetWire.request({ type: "delegation.remote.cancel", taskId: task.id }),
  ).toMatchObject({ ok: false, error: "not_ready" });
  expect(
    await f.targetWire.request({ type: "delegation.remote.cancel", taskId: task.id }),
  ).toMatchObject({ ok: true });
  handler.mockRestore();
  f.target.daemon.store.atomic((db) => {
    db.prepare("INSERT INTO thread_cleanup VALUES (?,?)").run(task.threadId, "delete-target");
    db.prepare("INSERT INTO thread_cleanup_members VALUES (?,?)").run(task.threadId, task.threadId);
  });
  expect(
    await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "cancelling" });
  expect(
    await f.targetWire.request({ type: "delegation.remote.cancel", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "cancelling" });
  f.target.daemon.store.atomic((db) => {
    db.prepare("DELETE FROM thread_cleanup_members WHERE thread_id=?").run(task.threadId);
    db.prepare("DELETE FROM thread_cleanup WHERE thread_id=?").run(task.threadId);
  });
  await f.target.daemon.engine!.stopForDeletion(task.threadId);
  expect(
    organizeThread(
      f.target.daemon.store,
      Command.parse({
        id: "delete-target",
        deviceId: "human",
        payload: { type: "thread.delete", threadId: task.threadId },
      }),
      Date.now(),
    ),
  ).toMatchObject({ ok: true });
  expect(
    await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "cancelled" });
  expect(
    await f.targetWire.request({ type: "delegation.remote.cancel", taskId: task.id }),
  ).toMatchObject({ ok: true, phase: "cancelled" });
});

async function admittedReturnTask(f: Awaited<ReturnType<typeof world>>) {
  const task = await f.delegate();
  f.source.controls.remote.poll("broker", f.lease);
  await transferRemoteContext(
    task,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  expect(await f.targetWire.request({ type: "delegation.remote.start", task })).toMatchObject({
    ok: true,
  });
  await f.target.daemon.engine!.flush();
  const thread = f.target.daemon.store.getThread(task.threadId);
  if (!thread?.rootAgentId) throw new Error("Missing target root");
  return {
    task,
    caller: { sessionId: "publication-test", threadId: task.threadId, agentId: thread.rootAgentId },
  };
}
async function publish(
  f: Awaited<ReturnType<typeof world>>,
  caller: import("@ace/protocol").McpAttribution,
  files: string[],
) {
  const lease = f.target.daemon.mcp.openSession(
    { ...caller, capabilities: ["thread_control"] },
    new AbortController().signal,
  );
  cleanup.push(() => lease.end());
  const response = await fetch(f.target.daemon.mcp.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lease.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "ace_device_task_publish",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ace_device_task_publish",
        arguments: { requestId: "published-output", files },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const result = await response.json();
  expect(result, JSON.stringify(result)).toMatchObject({
    result: { structuredContent: { ok: true } },
  });
  return RemoteArtifactManifest.parse(result.result.structuredContent.data);
}

test("remote agent explicitly publishes image and file through MCP; reverse relay imports source-owned bytes and preserves provenance without overwriting files", async () => {
  const f = await world();
  const { task, caller } = await admittedReturnTask(f);
  expect(
    await f.source.call({
      op: "device.task_publish",
      requestId: "not-a-receiving-task",
      attachments: [],
      files: ["result.png"],
    }),
  ).toMatchObject({ ok: false, code: "forbidden" });
  await writeFile(join(f.target.h.home, "result.png"), png);
  await writeFile(join(f.target.h.home, "result.txt"), "Remote output frozen bytes");
  await writeFile(join(f.target.h.home, "alias.txt"), "Remote output frozen bytes");
  await writeFile(join(f.source.h.home, "result.txt"), "Do not overwrite source workspace");
  const artifacts = await publish(f, caller, ["result.png", "result.txt", "alias.txt"]);
  expect(artifacts).toMatchObject({
    taskId: task.id,
    hostId: f.targetWire.hostId,
    threadId: task.threadId,
    parentThreadId: f.source.caller.threadId,
    attachments: [{ sha256: hash(png) }, { aliases: ["result.txt", "alias.txt"] }],
  });
  await writeFile(join(f.target.h.home, "result.txt"), "Changed after publish");
  const outcome = await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id });
  expect(outcome).toMatchObject({ ok: true, phase: "completed", artifacts });
  expect(
    f.source.controls.remote.report("broker", f.lease, {
      taskId: task.id,
      phase: "completed",
      artifacts,
    }),
  ).toBeUndefined();
  await returnRemoteArtifacts(
    task,
    artifacts,
    f.lease,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  for (const file of artifacts.attachments) {
    const read = await f.source.daemon.context.readAttachment(
      "source",
      f.source.caller.threadId,
      file.sha256,
      "original",
      0,
      65536,
    );
    expect(read.data).toEqual(
      file.sha256 === hash(png) ? png : Buffer.from("Remote output frozen bytes"),
    );
  }
  expect(await readFile(join(f.source.h.home, "result.txt"), "utf8")).toBe(
    "Do not overwrite source workspace",
  );
  const finished = f.source.controls.remote.report("broker", f.lease, {
    taskId: task.id,
    phase: "completed",
    artifacts,
    result: "Published selected results",
  });
  expect(finished).toMatchObject({ phase: "completed", artifacts, delivered: true });
  expect(
    f.source.controls.returns.retains(f.source.caller.threadId, artifacts.attachments[0]!.sha256),
  ).toBe(true);
  const wait = await f.source.call({ op: "device.task_wait", taskId: task.id });
  expect(wait).toMatchObject({
    ok: true,
    data: {
      artifacts,
      returnedFiles: [
        {
          hostId: task.sourceHostId,
          threadId: task.parentThreadId,
          provenance: { hostId: task.request.hostId, threadId: task.threadId },
        },
        { provenance: { aliases: ["result.txt", "alias.txt"] } },
      ],
    },
  });
  if (!wait.ok) throw new Error("Missing wait result");
  const returned = z
    .object({ returnedFiles: z.array(z.object({ path: z.string() })) })
    .parse(wait.data);
  expect(await readFile(returned.returnedFiles[0]!.path)).toEqual(png);
  await f.source.daemon.engine!.flush();
  const page = f.source.daemon.store.readItemPage(
    f.source.caller.threadId,
    f.source.daemon.store.headSeq() + 1,
    20,
    32768,
  );
  expect(
    page.items.some(
      (item) =>
        item.type === "message" &&
        item.attachments?.some((attachment) => attachment.sha256 === hash(png)),
    ),
  ).toBe(true);
});

test("return imports reject wrong provenance and Stop, preserve partial offsets across reconnect, and sealed outputs cannot change", async () => {
  const f = await world();
  const { task, caller } = await admittedReturnTask(f);
  await writeFile(join(f.target.h.home, "large.txt"), Buffer.alloc(140000, 97));
  const artifacts = await publish(f, caller, ["large.txt"]);
  const outcome = await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id });
  expect(outcome.artifacts).toEqual(artifacts);
  expect(
    await f.sourceRequest({
      type: "delegation.broker.return",
      lease: f.lease,
      artifacts: { ...artifacts, threadId: f.source.caller.threadId },
      operation: { op: "prepare" },
    }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  await expect(
    returnRemoteArtifacts(
      task,
      artifacts,
      f.lease,
      { request: f.sourceRequest },
      { request: f.targetRequest },
      async () => {
        const disconnected = await f.relayChannel();
        disconnected.close();
        return disconnected;
      },
      () => true,
    ),
  ).rejects.toThrow();
  expect(f.source.controls.returns.ready(task, artifacts)).toBe(false);
  expect(f.source.controls.remote.journal.get(task.id)?.phase).not.toBe("completed");
  const channel = await f.relayChannel();
  expect(
    await channel.request({
      type: "delegation.remote.output",
      requestId: "wrong-output",
      taskId: task.id,
      operation: { op: "read", sha256: "f".repeat(64), offset: 0 },
    }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  await f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "prepare" },
  });
  expect(
    f.source.controls.remote.report("broker", f.lease, { taskId: task.id, phase: "completed" }),
  ).toBeUndefined();
  expect(
    f.source.controls.remote.report("broker", f.lease, {
      taskId: task.id,
      phase: "completed",
      artifacts: { ...artifacts, attachments: [] },
    }),
  ).toBeUndefined();
  const begun = await f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "begin", sha256: artifacts.attachments[0]!.sha256 },
  });
  if (begun.context?.kind !== "upload") throw new Error("Missing source upload");
  await f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: {
      op: "chunk",
      uploadId: begun.context.uploadId,
      offset: 0,
      data: Buffer.alloc(65536, 97).toString("base64"),
    },
  });
  channel.close();
  await returnRemoteArtifacts(
    task,
    artifacts,
    f.lease,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  expect(f.source.controls.returns.ready(task, artifacts)).toBe(true);
  expect(
    await f.target.controls.port.execute(
      caller,
      RemoteAgentOperation.parse({
        op: "device.task_publish",
        requestId: "different",
        files: ["large.txt"],
      }),
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, code: "invalid" });
  await f.source.call({ op: "device.task_cancel", taskId: task.id });
  expect(
    await f.sourceRequest({
      type: "delegation.broker.return",
      lease: f.lease,
      artifacts,
      operation: { op: "begin", sha256: artifacts.attachments[0]!.sha256 },
    }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  expect(f.source.controls.remote.journal.get(task.id)?.phase).toBe("cancelling");
  expect(
    f.source.controls.returns.retains(f.source.caller.threadId, artifacts.attachments[0]!.sha256),
  ).toBe(false);
});

test("Stop during return upload admission durably releases the new reservation and retries cleanup after restart", async () => {
  const f = await world();
  const { task, caller } = await admittedReturnTask(f);
  await writeFile(join(f.target.h.home, "return.txt"), "task output");
  const artifacts = await publish(f, caller, ["return.txt"]);
  await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id });
  await f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "prepare" },
  });
  const context = f.source.daemon.context;
  const original = context.handle.bind(context);
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploadId = "";
  let cancelledAttempts = 0;
  const spy = vi.spyOn(context, "handle").mockImplementation(async (...args) => {
    if (ContextRequest.parse(args[1]).operation.op === "upload.cancel" && cancelledAttempts++ === 0)
      throw new Error("Transient shutdown");
    const reply = await original(...args);
    const result = ContextResult.parse(reply).result;
    if (ContextRequest.parse(args[1]).operation.op === "upload.begin" && result.kind === "upload") {
      uploadId = result.uploadId;
      await paused;
    }
    return reply;
  });
  const admission = f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "begin", sha256: artifacts.attachments[0]!.sha256 },
  });
  await vi.waitFor(() => expect(uploadId).not.toBe(""));
  await f.source.call({ op: "device.task_cancel", taskId: task.id });
  release?.();
  expect(await admission).toMatchObject({ ok: false, error: "forbidden" });
  expect(f.source.controls.returns.read(task.id)).toMatchObject({
    abandoned: true,
    uploads: { [uploadId]: { committed: false } },
  });
  spy.mockRestore();
  const restarted = new RemoteReturns(f.source.daemon.store);
  await restarted.cleanup(context, (error) => {
    throw error;
  });
  expect(
    await context.handle(remoteContextOwner, {
      type: "context.request",
      requestId: "after-stop",
      operation: { op: "upload.status", uploadId },
    }),
  ).toMatchObject({ result: { kind: "error", code: "not_found" } });
  expect(restarted.read(task.id)?.uploads).toEqual({});
});

test("broker disconnect during return admission preserves the owned offset for a replacement lease", async () => {
  const f = await world();
  const { task, caller } = await admittedReturnTask(f);
  await writeFile(join(f.target.h.home, "reconnect.txt"), "resume this output");
  const artifacts = await publish(f, caller, ["reconnect.txt"]);
  await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id });
  await f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "prepare" },
  });
  const context = f.source.daemon.context;
  const original = context.handle.bind(context);
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begun = false;
  const spy = vi.spyOn(context, "handle").mockImplementation(async (...args) => {
    const reply = await original(...args);
    if (ContextRequest.parse(args[1]).operation.op === "upload.begin") {
      begun = true;
      await paused;
    }
    return reply;
  });
  const admission = f.sourceRequest({
    type: "delegation.broker.return",
    lease: f.lease,
    artifacts,
    operation: { op: "begin", sha256: artifacts.attachments[0]!.sha256 },
  });
  await vi.waitFor(() => expect(begun).toBe(true));
  f.source.controls.remote.disconnect("broker");
  release?.();
  expect(await admission).toMatchObject({ ok: false, error: "forbidden" });
  spy.mockRestore();
  expect(f.source.controls.returns.read(task.id)?.abandoned).toBe(false);
  const lease = f.source.controls.remote.register("broker", [], () => true);
  if (!lease) throw new Error("Replacement broker unavailable");
  await returnRemoteArtifacts(
    task,
    artifacts,
    lease,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  expect(
    f.source.controls.remote.report("broker", lease, {
      taskId: task.id,
      phase: "completed",
      artifacts,
    }),
  ).toMatchObject({ phase: "completed", delivered: true });
  const result = await f.source.daemon.context.readAttachment(
    "source",
    task.parentThreadId,
    artifacts.attachments[0]!.sha256,
    "original",
    0,
    65536,
  );
  expect(result.data.toString()).toBe("resume this output");
});

test("retention releases sealed target exports, incoming context and source returns together", async () => {
  const f = await world();
  const { task, caller } = await admittedReturnTask(f);
  await writeFile(join(f.target.h.home, "old-result.txt"), "retained result bytes");
  const artifacts = await publish(f, caller, ["old-result.txt"]);
  const outcome = await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id });
  expect(outcome).toMatchObject({ ok: true, phase: "completed", artifacts });
  await returnRemoteArtifacts(
    task,
    artifacts,
    f.lease,
    { request: f.sourceRequest },
    { request: f.targetRequest },
    f.relayChannel,
    () => true,
  );
  const delivered = f.source.controls.remote.report("broker", f.lease, {
    taskId: task.id,
    phase: "completed",
    result: outcome.result,
    artifacts,
  });
  expect(delivered?.delivered).toBe(true);
  const file = artifacts.attachments[0];
  if (!file) throw new Error("Missing exported file");
  expect(f.source.controls.returns.retains(task.parentThreadId, file.sha256)).toBe(true);
  expect(f.target.controls.publications.retains(task.threadId, file.sha256)).toBe(true);
  await f.source.daemon.engine?.flush();
  await f.source.h.emit(task.parentThreadId, { type: "process.exited", deliberate: false });
  await f.source.daemon.engine?.flush();
  const retentionTime = (delivered?.finishedAt ?? task.createdAt) + 8 * 24 * 60 * 60 * 1000;
  f.source.controls.remote.journal.prune(retentionTime);
  f.target.controls.remote.journal.prune(retentionTime);
  expect(f.source.controls.returns.retains(task.parentThreadId, file.sha256)).toBe(false);
  expect(f.target.controls.publications.retains(task.threadId, file.sha256)).toBe(false);
  expect(
    await f.targetWire.request({ type: "delegation.remote.status", taskId: task.id }),
  ).toMatchObject({ ok: false, error: "not_found" });
  expect(f.source.controls.remote.journal.get(task.id)).toBeUndefined();
});
