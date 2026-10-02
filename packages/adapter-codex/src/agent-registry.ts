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
        buffer: [],
        hadTurn: false,
        mode: "default",
        open: new Map(),
        items: new Set(),
        requests: new Map(),
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
    if (p["status"] && agent.buffer.length === 0 && !agent.hadTurn) {
      const turns = list(p["turns"]);
      for (const turn of turns) {
        const t = obj(turn);
        const turnId = str(t["id"]);
        if (!turnId) continue;
        agent.hadTurn = true;
        facts.push({
          type: "turn.started",
          agent: agent.key,
          nativeTurnId: turnId,
          trigger: "unknown",
        });
        if (t["status"] === "inProgress") agent.turn = turnId;
        else
          facts.push({
            type: "turn.ended",
            agent: agent.key,
            nativeTurnId: turnId,
            outcome:
              t["status"] === "failed"
                ? "failed"
                : t["status"] === "interrupted"
                  ? "interrupted"
                  : "completed",
          });
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
    const buffered = agent.buffer.splice(0);
    for (const frame of buffered) facts.push(...config.replay(frame, now));
    return agent;
  }
  return { ensure, discover };
}
