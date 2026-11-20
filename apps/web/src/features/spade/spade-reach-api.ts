import { parseSpadeReach, type SpadeReach } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * How Spade reaches the person (ADR 0194): its settings, a bot's own switch, and answering a
 * request from the morning brief through the same routes the conversation's cards use.
 */

/** Every reach read; one machine's under `[...reachKey, machine key]`. */
export const reachKey = ["spade", "reach"] as const;

function sure(value: SpadeReach | undefined): SpadeReach {
  if (!value) throw new Error("Spade's notification settings didn't make sense.");
  return value;
}

export async function readReach(target: SpadeTarget, signal?: AbortSignal): Promise<SpadeReach> {
  return sure(parseSpadeReach(await spadeHttp(target, "GET", "/v1/reach", { signal })));
}

/** The fields given replace Spade's; an object's own fields one by one. */
export interface SpadeReachChange {
  notify?: boolean;
  dnd?: boolean;
  quiet?: { from: number; to: number } | null;
  budget?: { per_hour?: number | null; per_day?: number | null };
  brief?: { on?: boolean; at?: number; bots?: string[] | null; polish?: boolean };
  spend?: { on?: boolean; factor?: number; floor_micros?: number };
}

export async function setReach(target: SpadeTarget, change: SpadeReachChange): Promise<SpadeReach> {
  return sure(parseSpadeReach(await spadeHttp(target, "PUT", "/v1/reach", { body: change })));
}

const AgentReach = z.object({ notify: z.boolean().nullable().catch(null) });
const safeJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** A bot's own switch: true, false, or null to follow Spade's. */
export async function readAgentReach(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/reach`, { signal });
  const parsed = AgentReach.safeParse(safeJson(body));
  return parsed.success ? parsed.data.notify : null;
}

export async function setAgentReach(target: SpadeTarget, agent: string, notify: boolean | null) {
  await spadeHttp(target, "PUT", `/v1/agents/${segment(agent)}/reach`, { body: { notify } });
}

/** One tap from the brief: an approval allowed once or denied, or a question's one answer. */
export async function answerFromBrief(
  target: SpadeTarget,
  request: { conversation: string; kind: "approval" | "question"; callId: string },
  answer: { allowed: boolean } | { value: string | boolean },
): Promise<void> {
  const path = `/v1/conversations/${segment(request.conversation)}`;
  if ("allowed" in answer)
    await spadeHttp(target, "POST", `${path}/approvals/${segment(request.callId)}`, {
      body: { allowed: answer.allowed, always: false },
    });
  else
    await spadeHttp(target, "POST", `${path}/questions/${segment(request.callId)}`, {
      body: { answers: [answer.value] },
    });
}
