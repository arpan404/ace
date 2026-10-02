import { RecentSet } from "./retention.ts";
import type { Fact, Key } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import type { Agent } from "./translator-state.ts";
import { obj, str, list, type Obj } from "./native.ts";
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
  ): Agent {
    const agent = ensure(id, true, facts, p, parent);
    agent.known = true;
    const retained = config.takeBuffer(id);
    const buffered = retained.frames;
    if (retained.lost) agent.bufferLost = true;
    if (agent.bufferLost && !Array.isArray(p["turns"]) && !agent.unknownTask) {
      agent.unknownTask = true;
      facts.push({
        type: "background.started",
        agent: config.rootKey,
        task: `unknown:${id}`,
        kind: "other",
        title: "Recovering a truncated Codex thread",
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
    if (
      p["status"] &&
      (agent.bufferLost ||
        !buffered.some((frame) =>
          ["turn/started", "turn/completed"].includes(str(obj(frame.data)["method"])),
        )) &&
      (!agent.hadTurn || agent.bufferLost)
    ) {
      const turns = list(p["turns"]);
      for (const turn of turns) {
        const t = obj(turn);
        const turnId = str(t["id"]);
        if (!turnId) continue;
        const replay = (method: string, params: unknown) =>
          facts.push(
            ...config.replay(
              { seq: 0, t: now, dir: "recv", channel: "hydration", data: { method, params } },
              now,
            ),
          );
        if (!agent.ended.has(turnId)) replay("turn/started", { threadId: id, turn: t });
        for (const value of list(t["items"])) {
          const item = obj(value);
          const incomplete = item["status"] === "inProgress";
          replay(incomplete ? "item/started" : "item/completed", { threadId: id, turnId, item });
        }
        if (t["status"] !== "inProgress") replay("turn/completed", { threadId: id, turn: t });
      }
      if (!agent.hadTurn && obj(p["status"])["type"] === "active") {
        agent.turn = `observed:${id}`;
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
    if (agent.unknownTask && (!agent.bufferLost || Array.isArray(p["turns"]))) {
      facts.push({ type: "background.ended", task: `unknown:${id}`, status: "completed" });
      delete agent.unknownTask;
      delete agent.bufferLost;
    }
    config.discovered(facts);
    return agent;
  }
  return { ensure, discover };
}
