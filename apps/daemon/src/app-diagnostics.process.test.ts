import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
  DeviceId,
  SocketTicket,
  type DiagnosticReport,
  type DiagnosticsHealth,
} from "@ace/protocol";
import { expect, it } from "vitest";
import { startDaemon, readConfig, AdapterRegistry } from "./index.ts";
import { Client } from "./socket-test-support.ts";
import { createDevThread } from "./commands.ts";
import { fixture } from "./socket-test-support.ts";

const health: DiagnosticsHealth = {
  at: 1,
  eventLoop: { meanMs: null, p99Ms: null, maxMs: null },
  memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
  openHandles: 0,
  sqlite: { pageBytes: null, walBytes: null },
  activeSessions: null,
  queues: {},
  logs: { dropped: 0, failed: 0, queued: 0 },
};
const report: DiagnosticReport = {
  at: 1,
  checks: [{ id: "git", status: "ok", message: "Git available", fix: "Install Git" }],
};

it("the connected app can run checks and toolchain probes without creating a durable command", async () => {
  let at = 1;
  const f = await fixture({
    doctor: async () => ({
      at: at++,
      checks: [{ id: "git", status: "fail", message: "Not installed", fix: "Install Git" }],
    }),
    toolchains: async () => [
      { id: "android", available: false, detail: "Missing", hint: "Install Android Studio" },
    ],
  });
  try {
    const client = await f.connect();
    await client.next();
    const head = f.store.headSeq();
    for (const expected of [1, 2]) {
      client.send({
        type: "diagnostics.request",
        requestId: `check-${expected}`,
        operation: "doctor",
      });
      expect(await client.next()).toMatchObject({
        type: "diagnostics.result",
        report: { at: expected, checks: [{ status: "fail", fix: "Install Git" }] },
      });
    }
    client.send({ type: "diagnostics.request", requestId: "tools", operation: "toolchains" });
    expect(await client.next()).toMatchObject({
      type: "diagnostics.result",
      toolchains: [{ id: "android", hint: "Install Android Studio" }],
    });
    expect(f.store.headSeq()).toBe(head);
  } finally {
    await f.close();
  }
});

it("a second Run checks joins the one running, and a failure reaches both without probe details", async () => {
  const pending = Promise.withResolvers<never>();
  let runs = 0;
  const f = await fixture({
    doctor: () => {
      runs++;
      return pending.promise;
    },
  });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "diagnostics.request", requestId: "first", operation: "doctor" });
    client.send({ type: "diagnostics.request", requestId: "second", operation: "doctor" });
    // Requests are handled in order: once status answers, both have reached the run.
    client.send({ type: "diagnostics.request", requestId: "status", operation: "status" });
    expect(await client.next()).toMatchObject({ requestId: "status", run: { state: "running" } });
    pending.reject(new Error("private probe detail"));
    const answers = [await client.next(), await client.next()];
    expect(answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "first", error: "diagnostics_failed" }),
        expect.objectContaining({ requestId: "second", error: "diagnostics_failed" }),
      ]),
    );
    expect(JSON.stringify(answers)).not.toContain("private probe detail");
    expect(runs).toBe(1);
  } finally {
    await f.close();
  }
});

it("ace health still answers while the checks are running", async () => {
  const pending = Promise.withResolvers<DiagnosticReport>();
  const f = await fixture({
    doctor: () => pending.promise,
    health: async () => health,
  });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "diagnostics.request", requestId: "checks", operation: "doctor" });
    client.send({ type: "diagnostics.health", requestId: "health" });
    expect(await client.next()).toMatchObject({
      type: "diagnostics.health.result",
      requestId: "health",
      ok: true,
    });
    pending.resolve(report);
    expect(await client.next()).toMatchObject({ requestId: "checks", report });
  } finally {
    await f.close();
  }
});

it("checks keep running after the app that started them leaves, and a new connection reads and joins them", async () => {
  const pending = Promise.withResolvers<DiagnosticReport>();
  let at = 100;
  const f = await fixture({ doctor: () => pending.promise, now: () => at });
  try {
    const first = await f.connect();
    await first.next();
    first.send({ type: "diagnostics.request", requestId: "start", operation: "doctor" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.close();

    const second = await f.connect();
    await second.next();
    second.send({ type: "diagnostics.request", requestId: "status", operation: "status" });
    expect(await second.next()).toMatchObject({
      requestId: "status",
      run: { state: "running", operation: "doctor", startedAt: 100 },
    });
    second.send({ type: "diagnostics.request", requestId: "join", operation: "doctor" });
    second.send({ type: "diagnostics.request", requestId: "joined", operation: "status" });
    expect(await second.next()).toMatchObject({ requestId: "joined", run: { state: "running" } });
    at = 160;
    pending.resolve(report);
    expect(await second.next()).toMatchObject({ requestId: "join", report });
    second.send({ type: "diagnostics.request", requestId: "after", operation: "status" });
    expect(await second.next()).toMatchObject({
      run: { state: "done", startedAt: 100, finishedAt: 160, report },
    });
  } finally {
    await f.close();
  }
});

it("support export works before adding a project, redacts secrets, and includes conversations only when chosen locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-app-diagnostics-"));
  const report = {
    at: 1,
    checks: [{ id: "git", status: "ok" as const, message: "Git available", fix: "Install Git" }],
  };
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: { doctor: async () => report, toolchains: async () => [] },
  });
  const token = await readFile(daemon.tokenPath, "utf8");
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("support-owner"),
      token,
    });
    await client.next();
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(
      join(root, "logs", "ace.999.jsonl"),
      JSON.stringify({
        token,
        message:
          'diagnostic included: {"credentials":{"login":"OPAQUE_EXPORT_CREDENTIAL"},"code":7}',
        wrapped:
          'request failed: "{\\"credentials\\":{\\"login\\":\\"OPAQUE_WRAPPED_CREDENTIAL\\"}}"',
        truncated: 'request failed: {"credentials":{"login":"OPAQUE_TRUNCATED_CREDENTIAL"',
      }) + "\n",
    );
    const workspace = daemon.store.createWorkspace(join(root, "fictional-repo"), "Test");
    const thread = createDevThread(daemon.store, workspace);
    daemon.store.appendEvents(thread.id, [
      { type: "thread.updated", title: "Conversation opt-in" },
    ]);
    let privateArtifact = "";
    for (const includeThreads of [false, true]) {
      client.send({
        type: "files.request",
        requestId: "export",
        scope: "support",
        operation: { op: "artifact.support", includeThreads },
      });
      const exported = await client.next();
      if (
        exported.type !== "files.result" ||
        !exported.value ||
        typeof exported.value !== "object" ||
        !("artifactId" in exported.value) ||
        typeof exported.value.artifactId !== "string"
      )
        throw new Error(JSON.stringify(exported));
      if (includeThreads) privateArtifact = exported.value.artifactId;
      client.send({
        type: "files.request",
        requestId: "download",
        scope: "support",
        operation: { op: "artifact.download", artifactId: exported.value.artifactId, offset: 0 },
      });
      const ready = await client.next();
      if (ready.type !== "files.ready") throw new Error("Missing download");
      const parts: Buffer[] = [];
      for (;;) {
        client.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
        const chunk = await client.next();
        if (chunk.type !== "files.data") throw new Error("Missing chunk");
        if (chunk.eof) break;
        parts.push(Buffer.from(chunk.data, "base64"));
      }
      const bundle = gunzipSync(Buffer.concat(parts)).toString();
      expect(bundle).toContain("diagnostic included");
      expect(bundle).not.toContain("OPAQUE_EXPORT_CREDENTIAL");
      expect(bundle).not.toContain("OPAQUE_WRAPPED_CREDENTIAL");
      expect(bundle).not.toContain("OPAQUE_TRUNCATED_CREDENTIAL");
      expect(bundle).toContain("Git available");
      expect(bundle).not.toContain(token.trim());
      expect(bundle.includes("Conversation opt-in")).toBe(includeThreads);
    }
    await client.close();
    const paired = new Client(daemon.url);
    await once(paired.socket, "open");
    const pairedDevice = daemon.store.devices.create("Paired", ["read", "operate"], 1);
    const ticket = SocketTicket.parse(
      await (
        await fetch(daemon.url.replace("ws:", "http:") + "/v1/tickets", {
          method: "POST",
          headers: { Authorization: `Bearer ${pairedDevice.token}` },
        })
      ).json(),
    );
    paired.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: pairedDevice.device.id,
      ticket: ticket.ticket,
    });
    await paired.next();
    paired.send({
      type: "files.request",
      requestId: "denied",
      scope: "support",
      operation: { op: "artifact.support", includeThreads: true },
    });
    expect(await paired.next()).toMatchObject({
      type: "error",
      requestId: "denied",
      code: "forbidden",
    });
    paired.send({
      type: "files.request",
      requestId: "denied-download",
      scope: "support",
      operation: { op: "artifact.download", artifactId: privateArtifact, offset: 0 },
    });
    expect(await paired.next()).toMatchObject({
      type: "error",
      requestId: "denied-download",
      code: "forbidden",
    });
    paired.send({
      type: "files.request",
      requestId: "allowed",
      scope: "support",
      operation: { op: "artifact.support" },
    });
    expect(await paired.next()).toMatchObject({ type: "files.result", requestId: "allowed" });
    await paired.close();
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
