import { z } from "zod";
import type { Fact } from "@ace/core";
import type { Agent } from "./translator-state.ts";
const Model = z.string().min(1).max(256);
export function confirmModel(agent: Agent, value: unknown, facts: Fact[]): void {
  const parsed = Model.safeParse(value);
  if (!parsed.success || agent.model === parsed.data) return;
  agent.model = parsed.data;
  facts.push({ type: "agent.linked", agent: agent.key, model: parsed.data });
}
