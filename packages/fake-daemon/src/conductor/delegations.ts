import { ThreadId, type ConductorRunView } from "@ace/protocol";
import type { FakeServiceContext } from "../service-context.ts";
import type { FakeDeckRun } from "./types.ts";

/** Fake lane links open ordinary fake threads through the same client thread API. */
export function fakeDelegations(
  run: FakeDeckRun,
  host?: FakeServiceContext,
): ConductorRunView["delegations"] {
  return run.cards
    .filter((card) => card.kind === "work" && card.state !== "planned")
    .slice(0, 64)
    .flatMap((card) =>
      (["worker", "reviewer"] as const).map((role) => {
        const workerId = card.lane?.threadId ?? `${run.id}.${card.id}.thread`;
        const threadId = role === "worker" ? workerId : `${workerId}.review`;
        const provider = card.lane?.[role].provider ?? "codex";
        if (host && !host.thread(threadId)) {
          host.createThread?.({
            id: threadId,
            workspaceId: run.workspaceId,
            title: card.title,
            provider,
          });
          host.apply?.(threadId, [
            {
              type: "agent.seen",
              agent: "root",
              name: card.title,
              origin: "ace",
              fidelity: "full",
              cwd: "/fake/deck",
              native: { provider, nativeId: threadId },
            },
          ]);
        }
        const settled = card.state === "merged" || ["cancelled", "merged"].includes(run.phase);
        const thread = host?.thread(threadId)?.thread;
        if (host && thread) {
          const status = settled
            ? { state: "done" as const }
            : run.phase === "paused" ||
                card.state === "escalated" ||
                (role === "reviewer" && card.state !== "in_review") ||
                (role === "worker" && card.state === "in_review")
              ? { state: "waiting" as const, on: "queue" as const }
              : { state: "working" as const, agents: 1 };
          if (JSON.stringify(status) !== JSON.stringify(thread.status))
            host.update(threadId, { type: "thread.updated", status });
        }
        const rootId = `${run.id}.root`;
        const child = host?.thread(threadId)?.thread;
        if (host && child)
          host.apply?.(rootId, [
            {
              type: "agent.seen",
              agent: threadId,
              parent: "root",
              origin: "ace",
              fidelity: "full",
              cwd: "/fake/deck",
              native: { provider, nativeId: threadId },
              name: card.title,
            },
            {
              type: "agent.external",
              agent: threadId,
              threadId: ThreadId.parse(threadId),
              status: child.status,
            },
          ]);
        return {
          laneId: `${card.id}.${role}`,
          workstream: card.id,
          threadId,
          agentId: host?.thread(threadId)?.thread.rootAgentId ?? `${run.id}.${card.id}.agent`,
          parentThreadId: `${run.id}.root`,
          parentAgentId: host?.thread(rootId)?.thread.rootAgentId ?? `${run.id}.root.agent`,
          provider,
          account: card.lane?.[role].account ?? `local.${provider}`,
          generation: Math.max(card.round - 1, 0),
          phase: settled ? "settled" : "running",
        };
      }),
    );
}

/** Human gates keep the fake root's canonical status at needs_you, like the real engine. */
export function fakeDeckRoot(run: FakeDeckRun, host?: FakeServiceContext) {
  if (!host) return;
  const id = `${run.id}.root`;
  if (!host.thread(id)) {
    host.createThread?.({ id, workspaceId: run.workspaceId, title: run.goal, provider: "codex" });
    host.apply?.(id, [
      {
        type: "agent.seen",
        agent: "root",
        origin: "root",
        fidelity: "full",
        cwd: "/fake/deck",
        native: { provider: "codex", nativeId: id },
      },
    ]);
  }
  for (const interaction of Object.values(host.thread(id)?.interactions ?? {})) {
    const marker = interaction.raw.find((raw) => raw.type === "fake.conductor.gate");
    if (interaction.state === "pending" && marker?.name && marker.name !== run.gate?.id)
      host.apply?.(id, [
        {
          type: "interaction.closed",
          interaction: marker.name,
          state: run.phase === "cancelled" ? "cancelled" : "resolved",
        },
      ]);
  }
  if (run.gate)
    host.apply?.(id, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: run.gate.id,
        blocking: true,
        request: { kind: "plan_review", markdown: run.gate.body },
        raw: [{ type: "fake.conductor.gate", name: run.gate.id, data: {} }],
      },
    ]);
}
