// Process test: the account must survive the real paired-machine path (sender's delegate tool,
// TLS call, the target's describe, prepare and provider session open), which no unit test spans.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createInstance, openRegistry } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { MachineSummary, ThreadId, type AgentControlOperation } from "@ace/protocol";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";
import { machineRequest, type MachineTransport } from "./transport.ts";
import { pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const Delegated = z.object({ threadId: ThreadId });
const Listed = z.object({ machines: z.array(MachineSummary) });
const task = (name: string, extra: { accountId?: string; model?: string } = {}) =>
  ({
    op: "delegate_task",
    requestId: `${name}-on-studio`,
    task: `Do the ${name} part`,
    role: `Do-${name}-part`,
    provider: "claude",
    machine: "studio",
    project: "project",
    ...extra,
  }) satisfies AgentControlOperation;

/**
 * Two signed-in Claude accounts the person added on the target, with Shreyak chosen as the
 * default for new Claude threads; "Rijan" serves its own model.
 */
async function addAccounts(pair: Pair) {
  const registry = await openRegistry(join(pair.target.h.home, "daemon", "accounts.sqlite"));
  try {
    for (const [id, label] of [
      ["rijan-work", "Rijan"],
      ["shreyak", "Shreyak"],
    ] as const) {
      const homeDir = join(pair.target.h.home, `claude-${id}`);
      mkdirSync(homeDir, { recursive: true });
      await registry.register(createInstance({ id, provider: "claude", label, homeDir }));
      registry.ingest(id, {
        provider: "claude",
        observedAt: 1,
        timeZone: "UTC",
        payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      });
    }
    registry.selectProvider("claude", "shreyak");
  } finally {
    registry.close();
  }
  await seedScriptedModels(
    pair.target.daemon.models,
    scriptedModelInstance("claude", pair.target.h.home, "rijan-work"),
    "work-model",
  );
}

/** The account the target opened the child's provider session on. */
async function sessionAccount(pair: Pair, threadId: ThreadId) {
  await vi.waitFor(
    () => {
      if (!pair.target.h.contexts.get(threadId)) throw new Error("Session not open yet");
    },
    { timeout: 15_000 },
  );
  return pair.target.h.contexts.get(threadId)?.instanceId;
}

it("a delegate to another machine runs on the account named by id or label there, not its default; refuses one it lacks with its accounts; and uses its default when none is named", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await addAccounts(pair);

  const studio = Listed.parse((await pair.source.call({ op: "machines" })).data).machines[0];
  expect(studio?.accounts).toEqual(
    expect.arrayContaining([
      { provider: "claude", id: "rijan-work", label: "Rijan" },
      { provider: "claude", id: "shreyak", label: "Shreyak" },
    ]),
  );

  const byId = Delegated.parse(
    (await pair.source.call(task("by-id", { accountId: "rijan-work", model: "work-model" }))).data,
  ).threadId;
  expect(await sessionAccount(pair, byId)).toBe("rijan-work");

  const byLabel = Delegated.parse(
    (await pair.source.call(task("by-label", { accountId: "RIJAN", model: "work-model" }))).data,
  ).threadId;
  expect(await sessionAccount(pair, byLabel)).toBe("rijan-work");

  const threadsBefore = pair.target.daemon.store.listThreads().length;
  await expect(pair.source.call(task("unknown", { accountId: "__list__" }))).rejects.toMatchObject({
    code: "invalid_arguments",
    detail: expect.stringMatching(
      /Studio has no claude account "__list__"\..*Rijan \(rijan-work\).*Shreyak \(shreyak\)/,
    ),
  });
  await expect(
    pair.source.call(task("wrong-model", { accountId: "Rijan", model: "chosen-model" })),
  ).rejects.toMatchObject({
    code: "invalid_arguments",
    detail: expect.stringMatching(/does not serve chosen-model\. It serves work-model/),
  });
  // A refused delegate leaves nothing behind there.
  expect(pair.target.daemon.store.listThreads()).toHaveLength(threadsBefore);

  const unnamed = Delegated.parse((await pair.source.call(task("default"))).data).threadId;
  expect(await sessionAccount(pair, unnamed)).toBe("shreyak");
}, 60_000);

// The target answers describe as an older build does: without delegateAccounts.
const older: MachineTransport = async (profile, body, options) => {
  const answer = await machineRequest(profile, body, options);
  if (body.call.op !== "describe") return answer;
  const {
    delegateAccounts: _dropped,
    accounts: _none,
    ...rest
  } = z.record(z.string(), z.unknown()).parse(answer);
  return rest;
};

it("naming an account on a machine whose ace predates accounts across machines is refused here, and nothing starts there", async () => {
  const pair = await pairedMachines({ access: "operate", sourceTransport: older });
  await addAccounts(pair);
  const threadsBefore = pair.target.daemon.store.listThreads().length;
  await expect(
    pair.source.call(task("old-target", { accountId: "rijan-work" })),
  ).rejects.toMatchObject({
    code: "not_supported",
    detail: expect.stringMatching(/Studio runs an older ace that can't choose an account/),
  });
  expect(pair.target.daemon.store.listThreads()).toHaveLength(threadsBefore);
}, 60_000);
