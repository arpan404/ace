import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  parseSpadePackage,
  spadeBubbles,
  spadeContractEffects,
  spadeReplySteps,
  spadeView,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
    if (input) foldSpade(state, input);
  };
  return { stored, view: () => spadeView(state) };
}

/** The planner's reply that calls Flight watcher's `cheapest_fare` as job `j1`. */
function calls(c: ReturnType<typeof conversation>, machine?: string) {
  c.stored({ type: "user_message", text: "Cheapest fare KTM to DEL in January?" });
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [
      {
        id: "j1",
        name: "contract_call",
        arguments: { bot: "Flight watcher", contract: "cheapest_fare", input: { from: "KTM" } },
      },
    ],
  });
  c.stored({ type: "tool_started", reply: "r1", call_id: "j1", name: "contract_call" });
  c.stored({ type: "job_started", reply: "r1", job: "j1", name: "contract_call" });
  c.stored({
    type: "contract_called",
    job: "j1",
    call: "cc.c1.j1",
    bot: "fw",
    name: "Flight watcher",
    ...(machine ? { machine: "host-studio", machine_name: machine } : {}),
    contract: "cheapest_fare",
  });
  c.stored({
    type: "tool_finished",
    reply: "r1",
    call_id: "j1",
    name: "contract_call",
    content: "",
  });
  c.stored({ type: "step_finished", reply: "r1", text: "Asked Flight watcher." });
  c.stored({ type: "reply_finished", reply: "r1", text: "Asked Flight watcher." });
}

const lines = (c: ReturnType<typeof conversation>) =>
  spadeBubbles(c.view()).flatMap((bubble) =>
    bubble.kind === "contract" ? [[bubble.text, bubble.result]] : [],
  );

describe("a contract call in the caller's conversation", () => {
  test("is one line that says whom it asked, then what came back", () => {
    const c = conversation();
    calls(c);
    expect(lines(c)).toEqual([["Asking Flight watcher: cheapest_fare", ""]]);
    // Its reply is over, but the call is open: never done while it is.
    expect(c.view().busy).toBe(true);
    c.stored({
      type: "job_finished",
      job: "j1",
      name: "contract_call",
      content:
        '<contract_result call="cc.c1.j1" bot="Flight watcher" contract="cheapest_fare" status="returned">\n{\n  "fare": 182,\n  "currency": "USD"\n}\n</contract_result>',
    });
    expect(lines(c)).toEqual([["Asked Flight watcher: cheapest_fare", "fare 182 · currency USD"]]);
    expect(c.view().busy).toBe(false);
    // Not a step of its reply too: its own line says it.
    const reply = c.view().entries.find((entry) => entry.kind === "reply");
    expect(reply?.kind === "reply" ? spadeReplySteps(reply) : undefined).toBeUndefined();
  });

  test("says when it failed or was stopped, and which machine the bot is on", () => {
    const failed = conversation();
    calls(failed, "Studio");
    failed.stored({
      type: "job_finished",
      job: "j1",
      name: "contract_call",
      is_error: true,
      content:
        '<contract_result call="cc.c1.j1" status="failed">\noutput.fare: is a number\n</contract_result>',
    });
    expect(lines(failed)).toEqual([
      ["Flight watcher on Studio couldn't answer cheapest_fare", "output.fare: is a number"],
    ]);
    const stopped = conversation();
    calls(stopped);
    stopped.stored({ type: "stop_requested", reply: null, jobs: ["j1"] });
    stopped.stored({
      type: "job_finished",
      job: "j1",
      name: "contract_call",
      is_error: true,
      content: "Stopped by the person before it finished.",
    });
    expect(lines(stopped)[0]?.[0]).toBe("Stopped asking Flight watcher: cheapest_fare");
  });
});

describe("a contract call in the callee's conversation", () => {
  test("reads as the calling bot's request, never the person's words", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: 'cheapest_fare: {"from":"KTM"}',
      from_agent: {
        id: "planner",
        name: "Trip planner",
        depth: 1,
        contract: {
          call: "cc.c1.j1",
          contract: "cheapest_fare",
          input: { from: "KTM", month: "2027-01" },
        },
      },
    });
    const bubbles = spadeBubbles(c.view());
    expect(bubbles).toMatchObject([
      {
        kind: "other",
        agent: { name: "Trip planner" },
        text: "Asked for cheapest_fare: from KTM · month 2027-01",
      },
    ]);
  });
});

describe("a bot's contracts in its profile", () => {
  test("are listed from its package with what a call may do", () => {
    const linked = parseSpadePackage({
      source: "local",
      name: "local/flight-watcher",
      version: "local",
      effects: [],
      contracts: [{ name: "cheapest_fare", summary: "The cheapest fare.", effects: ["network"] }],
    });
    expect(linked?.contracts).toEqual([
      { name: "cheapest_fare", summary: "The cheapest fare.", effects: ["network"] },
    ]);
    expect(spadeContractEffects(["network"])).toBe(
      "It may reach outside its folder while answering.",
    );
    expect(spadeContractEffects([])).toBe("It only reads and uses its own things while answering.");
  });
});
