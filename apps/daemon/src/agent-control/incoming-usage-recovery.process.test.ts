import { randomUUID } from "node:crypto";
import { DelegationService } from "./delegations.ts";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readConfig, startDaemon } from "@ace/daemon";
import { RemoteAgentOperation } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { DeviceId } from "@ace/protocol";
import { remoteTarget } from "./remote-target-test-support.ts";

test("upgrade restores skipped incoming usage before first completion sealing and source budget enforcement", async () => {
  const f = await remoteTarget({ tokens: 40 });
  // Model the pre-upgrade owners: incoming root usage is persisted by the engine
  // and analytics, but not observed by the delegation journal or completion owner.
  f.target.controls.delegations.close();
  f.target.controls.publications.close();
  await f.emit({
    type: "usage",
    agent: "root",
    inputTokens: 30,
    outputTokens: 15,
    costUsd: 0.5,
    counterMode: "cumulative",
    counterKey: "original-session",
    usageScope: "provider_session",
  });
  await f.complete("Pre-upgrade answer");
  await f.target.daemon.close();
  const options = {
    config: readConfig({
      ACE_HOME: join(f.target.h.home, "daemon"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: "silent",
    }),
    engine: { registry: f.target.h.registry, clock: f.target.h.clock },
    modelInstances: [],
    workspaceActions: {
      forgeRunner: () => async () => ({ code: 1, stdout: "offline", truncated: false }),
    },
  };
  // Repeat the real daemon restart to guard durable usage in the sealed response.
  for (let restart = 0; restart < 2; restart++) {
    const daemon = await startDaemon(options);
    const wire = new Client(daemon.url);
    try {
      await once(wire.socket, "open");
      wire.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("upgrade-broker"),
        token: await readFile(daemon.tokenPath, "utf8"),
      });
      expect((await wire.next()).type).toBe("welcome");
      wire.send({ type: "delegation.remote.status", requestId: "old-result", taskId: f.task.id });
      let status = await wire.next();
      while (status.type !== "delegation.broker.result" || status.requestId !== "old-result")
        status = await wire.next();
      expect(status).toMatchObject({
        ok: true,
        phase: "completed",
        result: "Pre-upgrade answer",
        usage: { tokens: 45, cost: 0.5 },
      });
      if (restart === 1) {
        expect(
          f.remote.report("broker", f.lease, {
            taskId: f.task.id,
            phase: "completed",
            result: status.result,
            usage: status.usage,
          })?.usage,
        ).toEqual({ tokens: 45, cost: 0.5 });
        expect(
          await f.remote.execute(
            f.parent,
            RemoteAgentOperation.parse({
              ...f.task.request,
              op: "device.delegate",
              requestId: "over-budget",
            }),
            new AbortController().signal,
          ),
        ).toMatchObject({ ok: false, code: "limit" });
      }
    } finally {
      wire.close();
      await daemon.close();
    }
  }
});

test("usage recovery seeds cumulative counters before an unfinished incoming task resumes reporting", async () => {
  const f = await remoteTarget();
  f.target.controls.delegations.close();
  await f.emit({
    type: "usage",
    agent: "root",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.5,
    counterMode: "cumulative",
    counterKey: "original-session",
  });
  const recovered = new DelegationService({
    store: f.target.daemon.store,
    engine: f.target.daemon.engine!,
    models: f.target.daemon.models,
    clock: f.target.h.clock,
    id: randomUUID,
    onError: () => {},
  });
  try {
    await f.emit({
      type: "usage",
      agent: "root",
      inputTokens: 20,
      outputTokens: 5,
      costUsd: 0.75,
      counterMode: "cumulative",
      counterKey: "original-session",
    });
    await f.complete("Answer after usage recovery");
    expect(
      await f.request({
        type: "delegation.remote.status",
        requestId: "after-recovery",
        taskId: f.task.id,
      }),
    ).toMatchObject({
      ok: true,
      phase: "completed",
      result: "Answer after usage recovery",
      usage: { tokens: 25, cost: 0.75 },
    });
  } finally {
    recovered.close();
  }
});
