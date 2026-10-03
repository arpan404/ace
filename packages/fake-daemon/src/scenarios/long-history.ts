import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

/** A settled thread with `exchanges` question/answer pairs, for history paging. */
export function longHistory(exchanges = 60, id = "thread-router"): Scenario {
  const facts: Fact[] = [rootAgent("opencode"), turn("root")];
  for (let n = 1; n <= exchanges; n++)
    facts.push(
      message("root", `q${n}`, "user", `Question ${n}: what does route ${n} render?`),
      message("root", `a${n}`, "assistant", `Answer ${n}: route ${n} renders its own panel.`),
    );
  facts.push(endTurn("root"));
  return {
    thread: { id, workspaceId: "acme-web", title: "Document the router", provider: "opencode" },
    steps: [{ kind: "facts", label: "seeded", facts }],
  };
}
