import { afterEach, expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentId, ConductorSpec } from "@ace/protocol";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";

afterEach(closeDeckFixtures);

for (const scenario of ["root", "provider", "account"] as const) {
  test(`start rejects an unavailable ${scenario} before persisting a Deck or creating threads`, async () => {
    const h = await deckFixture();
    const model = { ...h.spec.policies.roles.worker[0], provider: "claude" };
    const spec = ConductorSpec.parse({
      ...h.spec,
      ...(scenario === "root" ? { rootAgentId: AgentId.parse("not-a-uuid") } : {}),
      ...(scenario === "provider"
        ? {
            constraints: {
              ...h.spec.constraints,
              providers: ["codex", "claude"],
              accounts: ["local.codex", "local.claude"],
            },
            policies: { ...h.spec.policies, roles: { ...h.spec.policies.roles, worker: [model] } },
          }
        : {}),
      ...(scenario === "account"
        ? { constraints: { ...h.spec.constraints, accounts: ["missing.codex"] } }
        : {}),
    });
    expect(await h.commands({ type: "conductor.start", runId: h.runId, spec })).toMatchObject({
      ok: false,
      error:
        scenario === "root"
          ? "conductor_invalid_root_agent"
          : scenario === "provider"
            ? "conductor_provider_unavailable"
            : "conductor_account_unavailable",
    });
    await h.advance(10_000);
    expect(await h.listRuns()).toEqual([]);
    expect(h.daemon.store.listThreads()).toEqual([]);
    await h.restart();
    expect(await h.listRuns()).toEqual([]);
    expect(h.daemon.store.listThreads()).toEqual([]);
    // The same run id can be corrected and admitted; no orphan poisons retries.
    expect(await h.startRun()).toMatchObject({ ok: true });
    await h.subscribe();
    await h.waitFor((run) => run.phase === "done");
  });
}

test("an explicitly logged-out default CLI account rejects start without creating a thread", async () => {
  const h = await deckFixture({ auth: "logged_out" });
  expect(await h.startRun()).toMatchObject({ ok: false, error: "conductor_account_unavailable" });
  await h.advance(10_000);
  expect(await h.listRuns()).toEqual([]);
  expect(h.daemon.store.listThreads()).toEqual([]);
});

test.each(["logged_in", "unknown"] as const)(
  "Deck runs on the explicitly selected normal CLI account while its quota authentication is unknown, discovery=%s",
  async (auth) => {
    const h = await deckFixture({ auth });
    if (!h.daemon.accounts) throw new Error("Missing accounts service");
    const accounts = await h.daemon.accounts.handle({
      type: "accounts.list",
      requestId: "accounts",
    });
    if (accounts.type !== "accounts.list") throw new Error("Missing accounts");
    const normal = accounts.accounts.find(
      (account) => account.provider === "codex" && account.id === "codex-cli-default",
    );
    if (!normal) throw new Error("Missing normal CLI account");
    expect(normal.quota.auth).toBe("unknown");
    const spec = ConductorSpec.parse({
      ...h.spec,
      constraints: { ...h.spec.constraints, accounts: [normal.id] },
    });
    expect(await h.commands({ type: "conductor.start", runId: h.runId, spec })).toMatchObject({
      ok: true,
    });
    await h.subscribe();
    await h.waitFor((run) => run.phase === "done");
    expect(h.daemon.store.listThreads().some((thread) => thread.live?.account === normal.id)).toBe(
      true,
    );
  },
);

test("start rejects a non-git workspace before creating a run or thread", async () => {
  const h = await deckFixture();
  const directory = join(h.home, "plain-folder");
  mkdirSync(directory);
  const workspaceId = h.daemon.store.createWorkspace(directory, "Plain folder");
  expect(
    await h.commands({ type: "conductor.start", runId: h.runId, spec: { ...h.spec, workspaceId } }),
  ).toMatchObject({ ok: false, error: "conductor_workspace_not_git" });
  expect(await h.listRuns()).toEqual([]);
  expect(h.daemon.store.listThreads()).toEqual([]);
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.phase === "done");
});

test.each([
  { provider: "opencode", modelId: "openai/scripted" },
  { provider: "pi", modelId: "anthropic/scripted" },
] as const)(
  "$provider model $modelId reaches the real engine and completes",
  async ({ provider, modelId }) => {
    const h = await deckFixture({ provider, model: modelId });
    const model = { ...h.spec.policies.roles.planner[0], model: modelId };
    const spec = ConductorSpec.parse({
      ...h.spec,
      constraints: { ...h.spec.constraints, models: [modelId] },
      policies: {
        ...h.spec.policies,
        roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
      },
    });
    expect(await h.commands({ type: "conductor.start", runId: h.runId, spec })).toMatchObject({
      ok: true,
    });
    await h.subscribe();
    await h.waitFor((run) => run.phase === "done");
    expect(h.daemon.store.listThreads().some((thread) => thread.live?.model === modelId)).toBe(
      true,
    );
  },
);
