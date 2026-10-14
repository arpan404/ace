import { confirmModel } from "./model.ts";
import { RecentSet } from "./retention.ts";
import type { Fact, Key } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import type { Agent, RecoveryRevision } from "./translator-state.ts";
import { obj, str, list, shellKey, type Obj } from "./native.ts";
export function createAgentRegistry(config: {
  agents: Map<string, Agent>;
  rootKey: Key;
  getRoot(): string;
  getCwd(): string;
  replay(frame: Frame, now: number): Fact[];
  takeBuffer(id: string): { frames: Frame[]; lost: boolean };
  discovered(facts: Fact[]): void;
}) {
  const { agents } = config;
  function ensure(
    id: string,
    known: boolean,
    facts: Fact[],
    metadata: Obj = {},
    parent?: string,
  ): Agent {
    let agent = agents.get(id);
    if (!agent) {
      const isRoot = id === config.getRoot();
      agent = {
        key: isRoot ? config.rootKey : id,
        ...(parent ? { parent } : {}),
        known,
        hadTurn: false,
        mode: "default",
        open: new Map(),
        items: new RecentSet(),
        completed: new RecentSet(),
        requests: new Map(),
        ended: new RecentSet(),
        async: new Set(),
        children: new Set(),
        backgroundResult: false,
        childResult: false,
      };
      agents.set(id, agent);
      facts.push({
        type: "agent.seen",
        agent: agent.key,
        ...(parent
          ? { parent: agents.get(parent)?.key ?? parent }
          : !isRoot && config.getRoot()
            ? { parent: config.rootKey }
            : {}),
        origin: isRoot ? "root" : "provider_subagent",
        fidelity: known ? "full" : "placeholder",
        native: {
          provider: "codex",
          nativeId: id,
          ...(typeof metadata["agentPath"] === "string" ? { path: metadata["agentPath"] } : {}),
        },
        cwd: str(metadata["cwd"], config.getCwd()),
      });
    }
    return agent;
  }
  function discover(
    id: string,
    p: Obj,
    facts: Fact[],
    now: number,
    parent?: string,
    spawnedBy?: string,
    revision?: RecoveryRevision,
  ): Agent {
    const wasKnown = agents.get(id)?.known === true;
    const agent = ensure(id, true, facts, p, parent);
    agent.known = true;
    confirmModel(agent, p["model"], facts);
    // Known threads receive frames directly; repeated metadata cannot imply newly lost history.
    const retained = wasKnown ? { frames: [], lost: false } : config.takeBuffer(id);
    const buffered = retained.frames;
    if (Array.isArray(p["turns"])) agent.recoveryUncertain = revision?.uncertain === true;
    if (retained.lost) agent.bufferLost = true;
    if (
      ((agent.bufferLost && !Array.isArray(p["turns"])) || agent.recoveryUncertain) &&
      !agent.unknownTask
    ) {
      agent.unknownTask = true;
      facts.push({
        type: "background.started",
        agent: config.rootKey,
        task: `unknown:${id}`,
        kind: "other",
        title: "Recovering uncertain Codex child work",
        stoppable: false,
      });
    }
    if (parent) {
      agent.parent = parent;
      agents.get(parent)?.children.add(id);
      facts.push({
        type: "agent.seen",
        agent: agent.key,
        parent: agents.get(parent)?.key ?? parent,
        ...(spawnedBy ? { spawnedBy } : {}),
        origin: "provider_subagent",
        fidelity: "full",
        native: {
          provider: "codex",
          nativeId: id,
          ...(typeof p["agentPath"] === "string" ? { path: p["agentPath"] } : {}),
        },
        cwd: str(p["cwd"], config.getCwd()),
        name: str(p["agentNickname"], str(p["agentPath"]).split("/").at(-1) ?? id),
      });
    }
    if (p["status"]) {
      const preserveObserved = agent.hadTurn;
      const currentSnapshot = !revision || revision.read === revision.current;
      const turns = list(p["turns"]);
      const replay = (method: string, params: unknown) =>
        facts.push(
          ...config.replay(
            { seq: 0, t: now, dir: "recv", channel: "hydration", data: { method, params } },
            now,
          ),
        );
      if (
        currentSnapshot &&
        revision?.uncertain !== true &&
        revision?.outputRecovery === true &&
        agent.turn?.startsWith("observed:") &&
        obj(p["status"])["type"] === "idle" &&
        !turns.some((turn) => obj(turn)["status"] === "inProgress")
      )
        replay("turn/completed", { threadId: id, turn: { id: agent.turn, status: "completed" } });
      for (const turn of turns) {
        const t = obj(turn);
        const turnId = str(t["id"]);
        if (!turnId) continue;
        if (
          currentSnapshot &&
          !agent.ended.has(turnId) &&
          (!preserveObserved || (!agent.turn && t["status"] === "inProgress"))
        )
          replay("turn/started", { threadId: id, turn: t });
        for (const value of list(t["items"])) {
          const item = obj(value);
          if (agent.completed.has(str(item["id"]))) continue;
          const incomplete = item["status"] === "inProgress";
          replay(incomplete ? "item/started" : "item/completed", { threadId: id, turnId, item });
        }
        if (t["status"] !== "inProgress") replay("turn/completed", { threadId: id, turn: t });
      }
      if (
        currentSnapshot &&
        revision?.uncertain !== true &&
        revision?.liveTerminalItems !== undefined
      ) {
        const live = new Set(revision.liveTerminalItems);
        for (const itemId of agent.terminalItems ?? [])
          if (!live.has(itemId))
            facts.push({ type: "background.ended", task: shellKey(itemId), status: "completed" });
        const recoveredTerminals = new Set<string>();
        for (const itemId of live) {
          if (typeof itemId !== "string" || agent.open.has(itemId)) continue;
          recoveredTerminals.add(itemId);
          if (!agent.terminalItems?.has(itemId))
            facts.push({
              type: "background.started",
              agent: agent.key,
              task: shellKey(itemId),
              kind: "shell",
              title: "Codex background command",
              stoppable: true,
            });
        }
        agent.terminalItems = recoveredTerminals;
        const settled = new Set(
          turns
            .map(obj)
            .filter((turn) => turn["status"] !== "inProgress")
            .map((turn) => str(turn["id"])),
        );
        for (const [itemId, open] of agent.open) {
          if (
            open.data["type"] !== "commandExecution" ||
            !settled.has(open.turn) ||
            live.has(itemId)
          )
            continue;
          facts.push(
            ...config.replay(
              {
                seq: 0,
                t: now,
                dir: "recv",
                channel: "hydration",
                data: {
                  method: "item/completed",
                  params: {
                    threadId: id,
                    turnId: open.turn,
                    item: { ...open.data, status: "completed" },
                  },
                },
              },
              now,
            ),
          );
        }
      }
      if (
        currentSnapshot &&
        !agent.turn &&
        (!agent.hadTurn || turns.length === 0) &&
        obj(p["status"])["type"] === "active"
      ) {
        agent.turn =
          revision?.outputRecovery === true
            ? `observed:${id}:${revision?.current ?? 0}`
            : `observed:${id}`;
        agent.hadTurn = true;
        facts.push({
          type: "turn.started",
          agent: agent.key,
          nativeTurnId: agent.turn,
          trigger: "unknown",
        });
      }
    }
    if (!agent.bufferLost || !Array.isArray(p["turns"]))
      for (const frame of buffered) facts.push(...config.replay(frame, now));
    if (
      agent.unknownTask &&
      !agent.recoveryUncertain &&
      (!agent.bufferLost || Array.isArray(p["turns"]))
    ) {
      facts.push({ type: "background.ended", task: `unknown:${id}`, status: "completed" });
      delete agent.unknownTask;
      delete agent.bufferLost;
    }
    if (Array.isArray(p["turns"])) delete agent.bufferLost;
    config.discovered(facts);
    return agent;
  }
  return { ensure, discover };
}
