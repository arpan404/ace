import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MachineSummary, type ThreadId } from "@ace/protocol";
import { invoke } from "../browser-mcp-test-support.ts";
import { pairedMachines } from "./machine-test-support.ts";
import { fleetWindow, sourceProfile } from "./grants-test-support.ts";

const Machines = z.object({ machines: z.array(MachineSummary) });
const ToolResult = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional(),
  }),
});
type Pair = Awaited<ReturnType<typeof pairedMachines>>;

/** An agent in `threadId` on the source calls one ace tool, as its provider would over MCP. */
async function agentCalls(pair: Pair, threadId: ThreadId, name: string, args: unknown) {
  const agentId = pair.source.daemon.store.getThread(threadId)?.rootAgentId;
  if (!agentId) throw new Error("No agent");
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: `commands-${threadId}`, threadId, agentId, capabilities: ["agents"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };
  return ToolResult.parse(await (await invoke(connection, name, args)).json()).result;
}

it("an agent runs a command on a machine that allows it, and machines says which do", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const window = await fleetWindow(pair.target);
  const listed = async () =>
    Machines.parse((await pair.source.call({ op: "machines" })).data).machines[0]?.tools;
  expect(await listed()).not.toContain("commands");
  await window.set(sourceProfile(pair).deviceId, "commands", "operate");
  expect(await listed()).toContain("commands");

  const { threadId } = pair.source.caller;
  const ran = await agentCalls(pair, threadId, "command_run", {
    machine: "studio",
    project: "project",
    command: "echo from-the-mac",
  });
  expect(ran.isError, JSON.stringify(ran)).not.toBe(true);
  expect(ran.content.map((part) => part.text)).toContain("stdout:\nfrom-the-mac\n");

  // Command tools only exist for other machines.
  const local = await agentCalls(pair, threadId, "command_run", { command: "echo here" });
  expect(local.isError).toBe(true);
  await window.close();
});

it("a read-only thread can't run commands on another machine; nothing reaches it", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const window = await fleetWindow(pair.target);
  await window.set(sourceProfile(pair).deviceId, "commands", "operate");
  const engine = pair.source.daemon.engine;
  const created = pair.source.controls.delegations.command("read-only-reviewer", {
    type: "thread.create",
    workspaceId: pair.source.workspace,
    provider: "codex",
    access: "read-only",
    input: [{ type: "text", text: "Review" }],
  });
  if (!created.ok || !created.threadId) throw new Error(created.error);
  const threadId = created.threadId;
  await engine?.flush();
  await vi.waitFor(() => expect(engine?.access(threadId)).toBe("read-only"));

  const refused = await agentCalls(pair, threadId, "command_run", {
    machine: "studio",
    project: "project",
    command: "touch should-not-exist",
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("read-only");
  expect(pair.target.daemon.store.listThreads().filter((thread) => thread.details?.guest)).toEqual(
    [],
  );
  await window.close();
});
