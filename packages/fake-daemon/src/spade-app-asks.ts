import type { FakeSpadeAgent, FakeSpadeApi } from "./spade-api.ts";

/** One call of a connected app that asks the person, as Spade's gate put it (ADR 0202, amendment 5). */
export interface FakeAppAsk {
  callId: string;
  /** As offered: `<connection>__<tool>`. */
  name: string;
  args: unknown;
  reason?: string;
  /** What the gate read it as doing; absent: undeclared. */
  effect?: string;
  /** `app` (the default): an ordinary write offered an Always allow for the app; `null`: none. */
  ask?: string | null;
  /** The definition digest the person is shown; a fixed fake one by default. */
  definition?: string;
}

let replies = 0;

/** One reply making several calls of the connected app `app` at once, each asking the person. */
export function fakeAskApp(
  spade: FakeSpadeApi,
  agent: FakeSpadeAgent,
  app: string,
  calls: readonly FakeAppAsk[],
): void {
  const reply = `r-app-${++replies}`;
  spade.store(agent.conversation, { type: "reply_started", reply });
  const made = calls.map((call) => ({ id: call.callId, name: call.name }));
  spade.store(agent.conversation, { type: "step_finished", reply, text: "", calls: made });
  for (const call of calls) {
    const ask = call.ask === undefined ? "app" : call.ask;
    spade.store(agent.conversation, {
      type: "approval_requested",
      reply,
      call_id: call.callId,
      name: call.name,
      arguments: call.args,
      tool_key: call.definition ?? `def-${call.name}`,
      ...(ask ? { ask, app } : {}),
      ...(call.effect ? { effect: call.effect } : {}),
      ...(call.reason ? { reviewer_reason: call.reason } : {}),
    });
  }
  spade.status(agent, "waiting", "Waiting for you");
}
