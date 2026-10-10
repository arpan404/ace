import { expect, test, vi } from "vitest";
import { type ServiceRequest, type ServiceResponse } from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import { RemoteTask, RemoteDelegationResult, RemoteRelayTarget } from "@ace/protocol";
import { RemoteAgentBroker } from "./remote-agent-broker.ts";

const task = RemoteTask.parse({
  id: "a".repeat(64),
  sourceHostId: "source",
  rootThreadId: "parent",
  parentThreadId: "parent",
  parentAgentId: "root",
  parentProvider: "codex",
  parentPermissionMode: ":read-only",
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
  permissionMode: ":read-only",
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
  status: "completed" | "not_found",
  afterTransfer: "running" | "cancelling" | "expired" = "running",
  tasks: RemoteTask[] = [task],
) {
  const calls: string[] = [];
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
    if (input.type === "delegation.broker.poll") return reply(input, { ok: true, tasks });
    if (input.type !== "delegation.broker.report") throw new Error("Unexpected source request");
    reports++;
    if (reports === 2 && transferFinished && afterTransfer === "expired")
      return reply(input, { ok: false, error: "forbidden" });
    return reply(input, {
      ok: true,
      tasks: [
        { ...task, phase: reports === 2 && transferFinished ? afterTransfer : input.report.phase },
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
          status === "completed"
            ? { ok: true, phase: "completed", result: "Already finished" }
            : { ok: false, error: "not_found" },
        );
      case "delegation.remote.transport":
        return reply(input, { ok: true, relay });
      case "delegation.remote.start":
        return reply(input, { ok: true });
      case "delegation.remote.cancel":
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
        status: "online",
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
  return { broker, calls };
}

test("broker recovers adopted target status without repeating context uploads or admission", async () => {
  const f = world("completed");
  await f.broker.cycle();
  await vi.waitFor(() =>
    expect(f.calls.filter((call) => call === "delegation.broker.report")).toHaveLength(2),
  );
  expect(f.calls).not.toContain("delegation.remote.start");
  expect(f.calls).not.toContain("delegation.remote.transport");
  f.broker.close();
});
test.each(["cancelling", "expired"] as const)(
  "broker rechecks origin authority after relay transfer: %s",
  async (phase) => {
    const f = world("not_found", phase);
    await f.broker.cycle();
    await vi.waitFor(() => expect(f.calls).toContain("relay.close"));
    await vi.waitFor(() =>
      expect(
        f.calls.filter((call) => call === "delegation.broker.report").length,
      ).toBeGreaterThanOrEqual(2),
    );
    if (phase === "cancelling")
      await vi.waitFor(() => expect(f.calls).toContain("delegation.remote.cancel"));
    expect(f.calls).not.toContain("delegation.remote.start");
    f.broker.close();
  },
);

test("broker rotates tasks on the same host rather than starving later task identities", async () => {
  const second = RemoteTask.parse({
    ...task,
    id: "b".repeat(64),
    threadId: `remote-${"b".repeat(64)}`,
  });
  const f = world("completed", "running", [task, second]);
  await f.broker.cycle();
  await vi.waitFor(() => expect(f.calls).toContain(`status:${task.id}`));
  await vi.waitFor(() =>
    expect(f.calls.filter((call) => call === "delegation.broker.report")).toHaveLength(2),
  );
  await f.broker.cycle();
  await vi.waitFor(() => expect(f.calls).toContain(`status:${second.id}`));
  f.broker.close();
});
