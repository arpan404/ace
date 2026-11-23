import { expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeQuietLine,
  spadeView,
} from "./index.ts";

test("a bot moved off a coding subscription shows Spade's one line, once, in its chat", () => {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
    );
    if (input) foldSpade(state, input);
  };
  stored({ type: "user_message", text: "Hi" });
  stored({ type: "agent_configured", task: "", model: "work/gpt" });
  const line = "Spade bots no longer think with coding subscriptions, so this bot moved to GPT.";
  stored({ type: "model_replaced", from: "cli:codex/gpt-6.1-sol", to: "work/gpt", line });
  const quiet = spadeBubbles(spadeView(state)).flatMap((bubble) =>
    bubble.kind === "quiet" ? [spadeQuietLine(bubble.quiet).label] : [],
  );
  expect(quiet).toEqual([line]);
});
