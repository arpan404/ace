import type { Fact, Key } from "@ace/core";
import type { RunTrigger } from "@ace/protocol";
import type { Obj } from "./native.ts";
type OpenItem = { data: Obj; turn: string; streamStarted?: boolean };
export type Agent = {
  key: Key;
  parent?: string;
  known: boolean;
  unknownTask?: boolean;
  bufferLost?: boolean;
  turn?: string;
  hadTurn: boolean;
  mode: string;
  model?: string;
  open: Map<string, OpenItem>;
  items: Set<string>;
  completed: Set<string>;
  requests: Map<string, { item: string; turn: string }>;
  ended: Set<string>;
  async: Set<string>;
  children: Set<string>;
  plan?: { id: string; text: string };
  pendingTrigger?: RunTrigger;
  backgroundResult: boolean;
  childResult: boolean;
  unmatchedFlag?: { data: Obj; since: number };
  failureText?: string;
};
export interface TranslationContext {
  agents: Map<string, Agent>;
  tasks: Set<string>;
  asyncOwners: Map<string, { agent: Agent; item: string }>;
  discover(
    id: string,
    p: Obj,
    facts: Fact[],
    now: number,
    parent?: string,
    spawnedBy?: string,
  ): Agent;
  note(agent: Key, type: string, data: unknown, text?: string): Fact;
}
