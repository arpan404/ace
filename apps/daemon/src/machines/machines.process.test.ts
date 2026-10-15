import { expect, it } from "vitest";
import { z } from "zod";
import {
  MachineSummary,
  MonitorSnapshot,
  ThreadId,
  WaitResult,
  type AgentControlOperation,
} from "@ace/protocol";
import { invoke } from "../browser-mcp-test-support.ts";
import { pairedMachines } from "./machine-test-support.ts";

const Machines = z.object({ machines: z.array(MachineSummary) });
const Delegated = z.object({ threadId: ThreadId });
const ToolResult = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional(),
  }),
});
const delegation = {
  op: "delegate_task",
  requestId: "review-on-studio",
  task: "Summarize the open pull requests",
  role: "Reviewer",
  provider: "claude",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

it("an agent sees another paired machine only while that machine lets agents in", async () => {
  const pair = await pairedMachines();
  const outputs: unknown[] = [];
  const list = async () => {
    const result = await pair.source.call({ op: "machines" });
    outputs.push(result);
    return Machines.parse(result.data).machines;
  };
  expect(await list()).toEqual([]);

  await pair.access("operate");
  expect(await list()).toEqual([
    expect.objectContaining({
      machine: "studio",
      name: "Studio",
      status: "online",
      access: "operate",
      projects: [expect.objectContaining({ name: "project" })],
      tools: expect.arrayContaining(["agents", "browser"]),
      providers: expect.arrayContaining(["claude"]),
    }),
  ]);

  // Turning it off applies to the very next call, including starting work there.
  await pair.access("off");
  expect(await list()).toEqual([]);
  await expect(pair.source.call(delegation)).rejects.toMatchObject({
    code: "machine_unavailable",
  });
  expect(JSON.stringify(outputs)).not.toContain(pair.credential.token);
});

it("a task delegated to another machine runs there, and ace_wait here returns its result", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const started = await pair.source.call(delegation);
  const { threadId } = Delegated.parse(started.data);

  // The child is an ordinary thread on the other machine, in the named project.
  const child = pair.target.daemon.store.getThread(threadId);
  expect(child).toMatchObject({ workspaceId: pair.target.workspace, title: "Reviewer" });
  // A retried call with the same requestId is the same child, not a second one.
  expect(Delegated.parse((await pair.source.call(delegation)).data).threadId).toBe(threadId);

  const waiting = pair.source.call({
    op: "wait",
    threadIds: [threadId],
    mode: "all",
    timeoutSeconds: 120,
  });
  await pair.finish(threadId, "Two pull requests are ready to merge.");
  const waited = await waiting;
  expect(WaitResult.parse(waited.data)).toMatchObject({
    status: "ready",
    threads: [
      {
        threadId,
        state: "done",
        result: "Two pull requests are ready to merge.",
        machine: "Studio",
      },
    ],
  });

  const status = MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data);
  expect(status.children).toEqual([
    expect.objectContaining({ id: threadId, state: "done", machine: "Studio" }),
  ]);
  // The parent's subagent row names the machine the child ran on.
  const parent = pair.source.daemon.store.readItemPage(
    pair.source.caller.threadId,
    pair.source.daemon.store.headSeq() + 1,
    50,
    256 * 1024,
  );
  expect(parent.items).toContainEqual(
    expect.objectContaining({
      type: "delegation.started",
      childThreadId: threadId,
      phase: "settled",
      machine: { machine: "studio", name: "Studio" },
    }),
  );
  expect(JSON.stringify([started, waited, status])).not.toContain(pair.credential.token);
});

it("a read-only pairing can list the machine but can't start work on it", async () => {
  const pair = await pairedMachines({ access: "operate", scopes: ["read"] });
  const listed = Machines.parse((await pair.source.call({ op: "machines" })).data).machines;
  expect(listed).toEqual([expect.objectContaining({ machine: "studio", access: "read" })]);
  await expect(pair.source.call(delegation)).rejects.toMatchObject({ code: "machine_forbidden" });
  expect(pair.target.daemon.store.listThreads().map((thread) => thread.title)).not.toContain(
    "Reviewer",
  );
});

it("an agent opens a new site in the other machine's browser with nobody asked", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const { threadId, agentId } = pair.source.caller;
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: "cross-device", threadId, agentId, capabilities: ["browser"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };
  const result = ToolResult.parse(
    await (
      await invoke(connection, "ace_browser_open", {
        url: "https://docs.example.test/start",
        machine: "studio",
      })
    ).json(),
  ).result;
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]?.text).toContain("docs.example.test");
  // Permissions are the provider's: neither machine holds a request for the person.
  for (const machine of [pair.source, pair.target])
    expect(
      machine.daemon.store.listThreads().filter((thread) => thread.status.state === "needs_you"),
    ).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(pair.credential.token);
});

it("an offline machine fails clearly with what to do next", async () => {
  const pair = await pairedMachines({ access: "operate" });
  expect(Machines.parse((await pair.source.call({ op: "machines" })).data).machines).toHaveLength(
    1,
  );
  await pair.target.daemon.close();
  const failure = await pair.source.call(delegation).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "machine_offline",
    hint: expect.stringContaining("start ace there"),
  });
  // Seen opted in before, it stays listed as offline rather than vanishing.
  expect(Machines.parse((await pair.source.call({ op: "machines" })).data).machines).toEqual([
    expect.objectContaining({ machine: "studio", status: "offline", next: expect.any(String) }),
  ]);
  expect(JSON.stringify(failure)).not.toContain(pair.credential.token);
});
