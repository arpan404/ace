import { expect, test, vi } from "vitest";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { Client } from "@ace/client";
import { type ServiceRequest, type ServiceResponse } from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import {
  RemoteTaskReport,
  RemoteTask,
  RemoteDelegationResult,
  RemoteRelayTarget,
} from "@ace/protocol";
import { RemoteAgentBroker } from "./remote-agent-broker.ts";

const task = RemoteTask.parse({
  id: "a".repeat(64),
  sourceHostId: "source",
  rootThreadId: "parent",
  parentThreadId: "parent",
  parentAgentId: "root",
  parentProvider: "codex",
  parentAccess: "read-only",
  threadId: `remote-${"a".repeat(64)}`,
  request: {
    requestId: "work",
    hostId: "target",
    workspaceId: "project",
    provider: "codex",
    model: "model",
    role: "Review",
    task: "Review",
  },
  access: "read-only",
  phase: "queued",
  dispatched: true,
  delivered: false,
  createdAt: 0,
  context: {
    sourceHostId: "source",
    sourceThreadId: "parent",
    summary: "Parent snapshot",
    before: null,
    attachments: [],
  },
});
const reply = <Q extends ServiceRequest>(input: Q, body: object): ServiceResponse<Q> =>
  RemoteDelegationResult.parse({
    type: "delegation.broker.result",
    requestId: "request",
    ...body,
  }) as ServiceResponse<Q>;
function world(
  status: "running" | "completed" | "not_found" | "legacy" | "files" | "publication_failed",
  afterTransfer: "running" | "cancelling" | "expired" = "running",
  tasks: RemoteTask[] = [task],
  poll: () => RemoteTask[] = () => tasks,
  inactive?: (ids: string[]) => string[],
) {
  const calls: string[] = [];
  const phases: string[] = [];
  const emitted: RemoteTaskReport[] = [];
  const probes: string[][] = [];
  let online = true;
  let admitted = false;
  let cancelled = false;
  let reports = 0;
  let transferFinished = false;
  const relay = RemoteRelayTarget.parse({
    url: "ws://relay.test/",
    pinnedFingerprint: "A".repeat(52),
  });
  async function primary<Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> {
    calls.push(input.type);
    if (input.type === "delegation.broker.register")
      return reply(input, { ok: true, lease: "lease" });
    if (input.type === "delegation.broker.poll") {
      const ids = input.trackedTaskIds ?? [];
      probes.push(ids);
      return reply(input, {
        ok: true,
        tasks: poll(),
        ...(inactive ? { inactiveTaskIds: inactive(ids) } : {}),
      });
    }
    if (input.type !== "delegation.broker.report") throw new Error("Unexpected source request");
    reports++;
    phases.push(input.report.phase);
    emitted.push(RemoteTaskReport.parse(input.report));
    if (reports === 2 && transferFinished && afterTransfer === "expired")
      return reply(input, { ok: false, error: "forbidden" });
    return reply(input, {
      ok: true,
      tasks: [
        {
          ...(tasks.find((candidate) => candidate.id === input.report.taskId) ?? task),
          phase: reports === 2 && transferFinished ? afterTransfer : input.report.phase,
        },
      ],
    });
  }
  async function target<Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> {
    calls.push(input.type);
    if (input.type === "delegation.remote.status") calls.push(`status:${input.taskId}`);
    switch (input.type) {
      case "delegation.remote.status":
        return reply(
          input,
          status !== "not_found"
            ? {
                ok: true,
                phase: status === "running" ? "running" : "completed",
                ...(status === "running" ? {} : { result: "Already finished" }),
                truncated: true,
                ...(status === "publication_failed" ? { artifactsUnavailable: true } : {}),
                ...(status === "completed" || status === "files" || status === "publication_failed"
                  ? {
                      artifacts: {
                        taskId: input.taskId,
                        sourceHostId: task.sourceHostId,
                        parentThreadId: task.parentThreadId,
                        hostId: task.request.hostId,
                        threadId:
                          tasks.find((t) => t.id === input.taskId)?.threadId ?? task.threadId,
                        attachments:
                          status === "files"
                            ? [
                                {
                                  sha256: "c".repeat(64),
                                  name: "output.txt",
                                  mimeType: "text/plain",
                                  bytes: 12,
                                  kind: "text",
                                },
                              ]
                            : [],
                      },
                    }
                  : {}),
              }
            : { ok: false, error: "not_found" },
        );
      case "delegation.remote.transport":
        return reply(input, { ok: true, relay });
      case "delegation.remote.start":
        admitted = true;
        return reply(input, { ok: true });
      case "delegation.remote.cancel":
        cancelled = true;
        return reply(input, { ok: true, phase: "cancelled" });
      default:
        throw new Error("Unexpected target request");
    }
  }
  const client = {
    request: target,
    projects: {
      recentFolders: async () => {
        throw new Error("No discovery expected");
      },
    },
  };
  const broker = new RemoteAgentBroker({
    primary: { state: "ready", request: primary },
    pool: {
      ids: [],
      machine: () => ({
        status: online ? "online" : "offline",
        entry: MachineEntry.parse({
          hostId: "target",
          displayName: "Target",
          deviceId: "paired",
          target: { kind: "direct", url: "ws://target.test/" },
        }),
      }),
      client: () => client,
      contextRelay: async () => ({
        request: async (input) => {
          calls.push("relay.context");
          transferFinished = true;
          return RemoteDelegationResult.parse({
            type: "delegation.broker.result",
            requestId: input.requestId,
            ok: true,
            context: { kind: "draft", draftId: "draft" },
          });
        },
        close: () => calls.push("relay.close"),
      }),
    },
    scheduler: { set: () => () => {} },
    now: () => 0,
  });
  return {
    broker,
    calls,
    phases,
    emitted,
    probes,
    setOnline: (value: boolean) => {
      online = value;
    },
    admitted: () => admitted,
    cancelled: () => cancelled,
  };
}

test("broker recovers adopted target status without repeating context uploads or admission", async () => {
  const f = world("completed");
  await f.broker.cycle();
  await vi.waitFor(() => expect(f.phases).toContain("completed"));
  expect(f.phases).toContain("completed");
  expect(f.admitted()).toBe(false);
  expect(f.emitted.find((report) => report.phase === "completed")).toMatchObject({
    result: "Already finished",
    truncated: true,
  });
  f.broker.close();
});
test("an expired cancellation retrieves the sealed answer without another admission", async () => {
  const expired = RemoteTask.parse({
    ...task,
    phase: "failed",
    cancellingAt: 0,
    finishedAt: 30_000,
    delivered: true,
  });
  const f = world("completed", "running", [expired]);
  try {
    await f.broker.cycle();
    await vi.waitFor(() =>
      expect(f.emitted).toContainEqual(
        expect.objectContaining({
          taskId: task.id,
          result: "Already finished",
          phase: "completed",
        }),
      ),
    );
    expect(f.admitted()).toBe(false);
    expect(f.phases).not.toContain("running");
  } finally {
    f.broker.close();
  }
});
test.each(["cancelling", "expired"] as const)(
  "broker rechecks origin authority after relay transfer: %s",
  async (phase) => {
    const f = world("not_found", phase);
    await f.broker.cycle();
    await vi.waitFor(() =>
      expect(f.phases).toContain(phase === "cancelling" ? "cancelled" : "running"),
    );
    if (phase === "cancelling") await vi.waitFor(() => expect(f.cancelled()).toBe(true));
    expect(f.admitted()).toBe(false);
    f.broker.close();
  },
);

test("broker rotates tasks on the same host rather than starving later task identities", async () => {
  const second = RemoteTask.parse({
    ...task,
    id: "b".repeat(64),
    threadId: `remote-${"b".repeat(64)}`,
  });
  const f = world("running", "running", [task, second]);
  try {
    await vi.waitFor(async () => {
      await f.broker.cycle();
      expect(f.calls).toContain(`status:${task.id}`);
      expect(f.calls).toContain(`status:${second.id}`);
    });
  } finally {
    f.broker.close();
  }
});

test("every task on a host gets status routing across alternating active and retained cancellation pages", async () => {
  const tasks = Array.from({ length: 128 }, (_, index) => {
    const id = index.toString(16).padStart(64, "0");
    return RemoteTask.parse({
      ...task,
      id,
      threadId: `remote-${id}`,
      phase: index < 64 ? "running" : "failed",
      ...(index < 64 ? {} : { cancellingAt: 0, finishedAt: 30_000, delivered: true }),
    });
  });
  const pages = [tasks.slice(0, 64), tasks.slice(64)];
  let page = 0;
  const f = world("running", "running", tasks, () => pages[page++ % pages.length] ?? []);
  try {
    // cycle() deliberately leaves routing in the background. Keep polling until
    // the observable target messages cover every task, regardless of job timing.
    await vi.waitFor(
      async () => {
        await f.broker.cycle();
        expect(new Set(f.calls.filter((call) => call.startsWith("status:")))).toEqual(
          new Set(tasks.map((candidate) => `status:${candidate.id}`)),
        );
      },
      { timeout: 4000, interval: 1 },
    );
    expect(f.admitted()).toBe(false);
  } finally {
    f.broker.close();
  }
});

test("broker reports incompatible target outcomes as unavailable rather than losing returned artifacts", async () => {
  const f = world("legacy");
  await f.broker.cycle();
  await vi.waitFor(() => expect(f.phases).toContain("unavailable"));
  expect(f.phases).not.toContain("completed");
  f.broker.close();
});

test("repeated file-import failure returns the sealed answer and names the missing files", async () => {
  const f = world("files");
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = f.emitted.length;
    await f.broker.cycle();
    await vi.waitFor(() =>
      expect(
        f.emitted
          .slice(previous)
          .some((report) => report.phase === (attempt === 2 ? "completed" : "unavailable")),
      ).toBe(true),
    );
  }
  expect(f.emitted.find((report) => report.phase === "completed")).toMatchObject({
    result: "Already finished",
    truncated: true,
    artifactsUnavailable: true,
    error: expect.stringContaining("output.txt"),
  });
  f.broker.close();
});

test("file-import attempts survive disjoint poll pages until both preserved answers are acknowledged", async () => {
  const second = RemoteTask.parse({
    ...task,
    id: "b".repeat(64),
    threadId: `remote-${"b".repeat(64)}`,
  });
  const tasks = [task, second];
  let polls = 0;
  const f = world(
    "files",
    "running",
    tasks,
    () => [tasks[polls++ % 2] ?? task],
    () => [],
  );
  try {
    await vi.waitFor(
      async () => {
        await f.broker.cycle();
        expect(
          new Set(
            f.emitted
              .filter((report) => report.phase === "completed")
              .map((report) => report.taskId),
          ),
        ).toEqual(new Set(tasks.map((candidate) => candidate.id)));
      },
      { timeout: 4000, interval: 1 },
    );
    for (const candidate of tasks)
      expect(
        f.emitted.find((report) => report.taskId === candidate.id && report.phase === "completed"),
      ).toMatchObject({
        result: "Already finished",
        artifactsUnavailable: true,
        error: expect.stringContaining("output.txt"),
      });
  } finally {
    f.broker.close();
  }
});

test("source-confirmed reconciliation expiry releases routing and file-import attempts despite an offline target", async () => {
  const tasks = [task];
  let page = tasks;
  let expired = false;
  const f = world(
    "files",
    "running",
    tasks,
    () => page,
    (ids) => (expired ? ids : []),
  );
  try {
    await f.broker.cycle();
    await vi.waitFor(() => expect(f.phases).toContain("unavailable"));
    f.setOnline(false);
    tasks[0] = RemoteTask.parse({
      ...task,
      phase: "failed",
      delivered: true,
      cancellingAt: 0,
      finishedAt: 30_000,
    });
    await f.broker.cycle();
    page = [];
    // An ordinary page omission still receives a positive source liveness result.
    await vi.waitFor(async () => {
      await f.broker.cycle();
      expect(f.probes.at(-1)).toContain(task.id);
    });
    expired = true;
    await f.broker.cycle();
    await f.broker.cycle();
    expect(f.probes.at(-1)).toEqual([]);
    await f.broker.cycle();
    expect(f.probes.at(-1)).toEqual([]);

    // The source may admit the same stable request identity again after pruning.
    // It must get a fresh three-attempt import budget, without the old failure.
    expired = false;
    tasks[0] = task;
    page = tasks;
    f.setOnline(true);
    const before = f.emitted.length;
    await vi.waitFor(async () => {
      await f.broker.cycle();
      expect(f.emitted.slice(before).some((report) => report.phase === "completed")).toBe(true);
    });
    const returned = f.emitted.slice(before);
    expect(returned.filter((report) => report.phase === "unavailable")).toHaveLength(2);
    expect(returned.find((report) => report.phase === "completed")).toMatchObject({
      result: "Already finished",
      artifactsUnavailable: true,
      error: expect.stringContaining("output.txt"),
    });
  } finally {
    f.broker.close();
  }
});

test("source liveness checks rotate through more than one tracked page and stop after confirmed removal", async () => {
  const tasks = Array.from({ length: 128 }, (_, index) => {
    const id = index.toString(16).padStart(64, "0");
    return RemoteTask.parse({
      ...task,
      id,
      threadId: `remote-${id}`,
      phase: "failed",
      delivered: true,
      cancellingAt: 0,
      finishedAt: 30_000,
    });
  });
  const pages = [tasks.slice(0, 64), tasks.slice(64)];
  let page = 0;
  let removed = false;
  const f = world(
    "running",
    "running",
    tasks,
    () => (removed ? [] : (pages[page++ % 2] ?? [])),
    (ids) => (removed ? ids : []),
  );
  f.setOnline(false);
  try {
    await vi.waitFor(
      async () => {
        await f.broker.cycle();
        expect(new Set(f.probes.flat())).toEqual(new Set(tasks.map((candidate) => candidate.id)));
      },
      { timeout: 4000, interval: 1 },
    );
    removed = true;
    for (let cycle = 0; cycle < 4; cycle++) await f.broker.cycle();
    expect(f.probes.at(-1)).toEqual([]);
    expect(f.probes.every((ids) => ids.length <= 64)).toBe(true);
  } finally {
    f.broker.close();
  }
});

test("device discovery withdraws a connected host when its files relay is unavailable", async () => {
  const daemon = new FakeDaemon({ clock: () => 0 });
  let sequence = 0;
  const client = new Client({
    deviceId: MachineEntry.shape.deviceId.parse("browser"),
    credential: async () => daemon.token,
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `discovery-${++sequence}`,
  });
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
  let available = true;
  let now = 0;
  const registrations: string[][] = [];
  const remote = {
    projects: client.projects,
    request: <Q extends ServiceRequest>(input: Q): Promise<ServiceResponse<Q>> =>
      input.type === "delegation.remote.transport"
        ? Promise.resolve(
            reply(input, {
              ok: true,
              ...(available
                ? { relay: { url: "ws://relay.test/", pinnedFingerprint: "A".repeat(52) } }
                : {}),
            }),
          )
        : client.request(input),
  };
  const broker = new RemoteAgentBroker({
    primary: {
      state: "ready",
      request: async <Q extends ServiceRequest>(input: Q) => {
        if (input.type === "delegation.broker.register")
          registrations.push(input.hosts.map((host) => host.hostId));
        return reply(
          input,
          input.type === "delegation.broker.register"
            ? { ok: true, lease: "lease" }
            : { ok: true, tasks: [] },
        );
      },
    },
    pool: {
      ids: ["target"],
      machine: () => ({
        status: "online",
        entry: MachineEntry.parse({
          hostId: "target",
          displayName: "Target",
          deviceId: "paired",
          target: { kind: "direct", url: "ws://target.test/" },
        }),
      }),
      client: () => remote,
    },
    scheduler: { set: () => () => {} },
    now: () => now,
  });
  try {
    await vi.waitFor(async () => {
      await broker.cycle();
      expect(registrations.at(-1)).toEqual(["target"]);
    });
    available = false;
    now = 60001;
    await vi.waitFor(async () => {
      await broker.cycle();
      expect(registrations.at(-1)).toEqual([]);
    });
  } finally {
    broker.close();
    await client.close();
  }
});

test("a failed target publication delivers its preserved answer and an explicit files warning without retrying forever", async () => {
  const f = world("publication_failed");
  try {
    await f.broker.cycle();
    await vi.waitFor(() =>
      expect(f.emitted.some((report) => report.phase === "completed")).toBe(true),
    );
    expect(f.emitted.find((report) => report.phase === "completed")).toMatchObject({
      result: "Already finished",
      artifactsUnavailable: true,
      error: expect.stringContaining("publication"),
    });
    expect(f.phases).not.toContain("unavailable");
  } finally {
    f.broker.close();
  }
});
