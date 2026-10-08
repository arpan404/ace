import { WorkspaceId, ThreadId, type ConductorRunView } from "@ace/protocol";
import type { FakeServiceContext } from "../service-context.ts";
import type { FakeDeckCard, FakeDeckRun } from "./types.ts";

/*
 * The fake Deck's threads, as the native executor leaves them: a root thread per deck that holds
 * the conductor's gates as host interactions, and a delegated thread per lane, titled the way the
 * daemon titles them ("Deck worker: <card>"). A worker's question is a real interaction on its
 * thread, so it is answered with `interaction.resolve` like any provider question.
 */

/** The raw marker the daemon puts on a deck gate mirrored onto its root thread. */
export const deckGateMarker = "ace.conductor.gate";
/** The raw marker on a fake worker's question. */
const questionMarker = "fake.deck.question";

export const deckRootId = (run: FakeDeckRun) => `${run.id}.root`;
const questionKey = (card: FakeDeckCard) => `ask.${card.id}`;

function workerThread(run: FakeDeckRun, card: FakeDeckCard) {
  return card.lane?.threadId ?? `${run.id}.${card.id}.thread`;
}

/** Opens a card's question on its worker thread once; the daemon closes it when answered. */
function ask(host: FakeServiceContext, threadId: string, card: FakeDeckCard): void {
  const question = card.question;
  if (!question) return;
  const open = Object.values(host.thread(threadId)?.interactions ?? {}).some((interaction) =>
    interaction.raw.some((raw) => raw.type === questionMarker && raw.name === card.id),
  );
  if (open) return;
  host.apply?.(threadId, [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: questionKey(card),
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "choice",
            text: question.text,
            options: question.options,
            multiSelect: false,
            allowOther: false,
          },
        ],
      },
      raw: [{ type: questionMarker, name: card.id, data: {} }],
    },
  ]);
}

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
        const workerId = workerThread(run, card);
        const threadId = role === "worker" ? workerId : `${workerId}.review`;
        const provider = card.lane?.[role].provider ?? "codex";
        const deck = {
          deckId: run.id,
          runId: run.id,
          workspaceId: WorkspaceId.parse(run.workspaceId),
          role,
          laneId: `${card.id}.${role}`,
        };
        const workspaceId =
          host?.deckWorkspace?.(
            `${threadId}.workspace`,
            deck,
            ["cancelled", "merged"].includes(run.phase),
          ) ?? run.workspaceId;
        if (host && !host.thread(threadId)) {
          host.createThread?.({
            id: threadId,
            workspaceId,
            title: `Deck ${role}: ${card.id}`,
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
        if (host && JSON.stringify(host.thread(threadId)?.thread.deck) !== JSON.stringify(deck))
          host.update(threadId, { type: "thread.client.updated", changes: { deck } });
        const settled =
          ["approved", "merged", "declined"].includes(card.state) ||
          ["cancelled", "merged"].includes(run.phase);
        const asking = role === "worker" && !settled && !!card.question;
        if (host && asking) ask(host, threadId, card);
        const thread = host?.thread(threadId)?.thread;
        // An open question keeps the thread waiting on the person; the engine owns that status.
        if (host && thread && !asking) {
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
        const rootId = deckRootId(run);
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
        if (host && child) {
          host.apply?.(rootId, [
            {
              type: "item.upsert",
              agent: "root",
              item: `delegation:${threadId}`,
              draft: {
                type: "delegation.started",
                origin: "ace",
                childThreadId: ThreadId.parse(threadId),
                provider,
                title: child.title,
                role,
                phase: settled ? "settled" : "running",
                status: child.status,
                generation: Math.max(card.round - 1, 0),
                updatedAt: run.updatedAt,
                complete: settled,
                outcome: settled
                  ? {
                      threadId: ThreadId.parse(threadId),
                      outcome:
                        run.phase === "cancelled" || card.state === "declined"
                          ? "cancelled"
                          : "completed",
                      result: card.title,
                      truncated: false,
                      before: null,
                    }
                  : null,
              },
            },
          ]);
          if (settled)
            host.apply?.(rootId, [
              {
                type: "item.upsert",
                agent: "root",
                item: `delegation-result:${threadId}`,
                draft: {
                  type: "delegation.settled",
                  origin: "ace",
                  delivery: "tool",
                  complete: true,
                  results: [
                    {
                      threadId: ThreadId.parse(threadId),
                      outcome: run.phase === "cancelled" ? "cancelled" : "completed",
                      result: card.title,
                      truncated: false,
                      before: null,
                    },
                  ],
                },
              },
            ]);
        }
        return {
          laneId: `${card.id}.${role}`,
          workstream: card.id,
          threadId,
          agentId: host?.thread(threadId)?.thread.rootAgentId ?? `${run.id}.${card.id}.agent`,
          parentThreadId: rootId,
          parentAgentId: host?.thread(rootId)?.thread.rootAgentId ?? `${run.id}.root.agent`,
          provider,
          account: card.lane?.[role].account ?? `local.${provider}`,
          generation: Math.max(card.round - 1, 0),
          phase: settled ? "settled" : "running",
        };
      }),
    );
}

/** Each open worker question as the daemon lists it under needsUser: a provider gate. */
export function fakeProviderGates(
  run: FakeDeckRun,
  host?: FakeServiceContext,
): ConductorRunView["needsUser"] {
  if (!host) return [];
  return run.cards.flatMap((card) => {
    if (!card.question) return [];
    const threadId = workerThread(run, card);
    const interaction = Object.values(host.thread(threadId)?.interactions ?? {}).find(
      (entry) =>
        entry.state === "pending" &&
        entry.raw.some((raw) => raw.type === questionMarker && raw.name === card.id),
    );
    if (!interaction) return [];
    return [
      {
        id: interaction.id,
        kind: "provider" as const,
        workstream: card.id,
        lane: `${card.id}.worker`,
        generation: Math.max(card.round - 1, 0),
        message: "question needs your answer",
        gatedAt: interaction.createdAt,
        interactionId: interaction.id,
        threadId,
      },
    ];
  });
}

/** What an answered interaction meant to the fake Deck: a gate decision or a worker's answer. */
export function fakeDeckAnswer(
  runs: readonly FakeDeckRun[],
  threadId: string,
  key: string,
): { runId: string; gateId: string } | { runId: string; cardId: string } | undefined {
  for (const run of runs) {
    if (deckRootId(run) === threadId && run.gate?.id === key)
      return { runId: run.id, gateId: run.gate.id };
    const card = run.cards.find(
      (entry) =>
        entry.question && workerThread(run, entry) === threadId && questionKey(entry) === key,
    );
    if (card) return { runId: run.id, cardId: card.id };
  }
  return undefined;
}

/** Human gates keep the fake root's canonical status at needs_you, like the real engine. */
export function fakeDeckRoot(run: FakeDeckRun, host?: FakeServiceContext) {
  if (!host) return;
  const id = deckRootId(run);
  if (!host.thread(id)) {
    host.createThread?.({
      id,
      workspaceId: run.workspaceId,
      title: `Deck: ${run.goal}`,
      provider: "codex",
    });
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
  const deck = {
    deckId: run.id,
    runId: run.id,
    workspaceId: WorkspaceId.parse(run.workspaceId),
    role: "root" as const,
  };
  if (JSON.stringify(host.thread(id)?.thread.deck) !== JSON.stringify(deck))
    host.update(id, { type: "thread.client.updated", changes: { deck } });
  for (const interaction of Object.values(host.thread(id)?.interactions ?? {})) {
    const marker = interaction.raw.find((raw) => raw.type === deckGateMarker);
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
        request: {
          kind: "plan_review",
          title: "Deck needs your decision",
          markdown: run.gate.body,
        },
        raw: [
          { type: deckGateMarker, name: run.gate.id, data: { key: `deck.gate.${run.gate.id}` } },
        ],
      },
    ]);
}
