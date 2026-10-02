import type { Ports } from "./ports.ts";
import type { Completion, Fact, Gate, Lane } from "./schema.ts";

export interface FakeSession {
  lane: Lane;
  prompt: string;
  cwd: string;
  history: string[];
  paused: boolean;
  stopped: boolean;
}
/** Deterministic boundary fakes. Their observable trees, sessions, PRs and merges represent external effects. */
export function fakePorts(now: () => number) {
  const receipts = new Map<string, unknown>();
  const tree = new Map<string, { parentId: string; agentId: string }>();
  const sessions = new Map<string, FakeSession>();
  const interactions = new Map<string, Gate>();
  const bases = new Map<string, readonly Completion[]>();
  const merged: Completion[] = [];
  const prs: Completion[] = [];
  const conflicts = new Map<string, { message: string; trivial: boolean }>();
  const failedChecks = new Set<string>();
  function once<T>(key: string, action: () => T): T {
    if (receipts.has(key)) {
      // Values originate inside this fake, never from an external boundary.
      return receipts.get(key) as T;
    }
    if (receipts.size >= 32_768) throw new Error("fake_receipt_backpressure");
    const result = action();
    receipts.set(key, result);
    return result;
  }
  const ports: Ports = {
    orchestrator: {
      async attach(key, parentId, lane) {
        once(key, () => tree.set(lane.id, { parentId, agentId: lane.agentId }));
      },
    },
    engine: {
      async start(key, lane, cwd, prompt) {
        once(key, () => {
          if (!tree.has(lane.id)) throw new Error("lane_not_attached");
          sessions.set(lane.id, {
            lane: { ...lane },
            cwd,
            prompt,
            history: [prompt],
            paused: false,
            stopped: false,
          });
        });
      },
      async fork(key, lane, source, cwd, prompt) {
        once(key, () => {
          const parent = sessions.get(source);
          if (!parent || !tree.has(lane.id)) throw new Error("fork_source_missing");
          sessions.set(lane.id, {
            lane: { ...lane },
            cwd,
            prompt,
            history: [...parent.history, prompt],
            paused: false,
            stopped: false,
          });
        });
      },
      async control(key, lane, action) {
        return once(key, () => {
          const session = sessions.get(lane.id);
          if (session) {
            session.paused = action === "pause";
            if (action === "cancel") session.stopped = true;
          }
          return action === "cancel"
            ? [
                {
                  type: "status",
                  laneId: lane.id,
                  generation: lane.generation,
                  status: "done",
                  at: now(),
                } satisfies Fact,
              ]
            : [];
        });
      },
    },
    git: {
      async prepare(key, workspace, lane, _source, dependencies) {
        return once(key, () => {
          bases.set(lane.id, dependencies);
          return { cwd: `/fake/${workspace}/${lane.id}` };
        });
      },
      async merge(key, completion) {
        return once(key, () => {
          const conflict = conflicts.get(completion.branch);
          if (conflict) {
            conflicts.delete(completion.branch);
            return {
              revision: completion.revision,
              conflict: conflict.message,
              trivial: conflict.trivial,
            };
          }
          merged.push(completion);
          return { revision: completion.revision, conflict: null, trivial: false };
        });
      },
    },
    forge: {
      async openPR(key, completion) {
        return once(key, () => {
          prs.push(completion);
          return { revision: completion.revision };
        });
      },
      async verifyCI(key, revision) {
        return once(key, () => ({
          passed: !failedChecks.has(revision),
          summary: "Fake CI evidence",
        }));
      },
    },
    accounts: {
      async migrate(key, lane) {
        once(key, () => {
          const old = sessions.get(lane.id);
          if (!old) throw new Error("migration_source_missing");
          sessions.set(lane.id, {
            ...old,
            lane: { ...lane },
            history: [...old.history],
            paused: false,
            stopped: false,
          });
        });
      },
    },
    verification: {
      async check(key, revision) {
        return once(key, () => ({
          passed: !failedChecks.has(revision),
          summary: "Fake checks evidence",
        }));
      },
    },
    interactions: {
      async open(key, _root, item) {
        once(key, () => interactions.set(item.id, item));
      },
      async close(key, id) {
        once(key, () => interactions.delete(id));
      },
    },
  };
  return { ports, tree, sessions, interactions, merged, prs, conflicts, failedChecks };
}
