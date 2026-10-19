import { Item, ThreadId } from "@ace/protocol";
import { renderHandoff, selectHandoff } from "@ace/handoff";
import { expect, test } from "vitest";
import { handoffMarker } from "./handoff-marker.ts";
import { transcriptRowContent } from "./mobile-transcript.ts";

let ids = 0;
const message = (role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) =>
  Item.parse({
    id: `m-${++ids}`,
    agentId: "root",
    createdAt: ids,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text }],
    ...extra,
  });

const block = renderHandoff(
  selectHandoff(
    {
      threadId: ThreadId.parse("t"),
      throughSeq: 4,
      totalItems: 2,
      items: [
        message("user", "Fix the export", { origin: { kind: "person" } }),
        message("assistant", "Fixed it."),
      ],
    },
    4096,
  ),
);

const handoff = (origin: Record<string, unknown>, text = block) =>
  message("user", text, { synthetic: true, origin: { kind: "handoff", lossy: true, ...origin } });

test("a provider switch reads as a handoff from every carried model to the new one", () => {
  const marker = handoffMarker(
    handoff({
      from: { provider: "opencode", model: "muse-spark-1.3-contributor" },
      to: { provider: "claude", model: "claude-opus-4-1" },
      sources: [
        { provider: "codex", model: "gpt-5-codex" },
        { provider: "opencode", model: "muse-spark-1.3-contributor" },
      ],
    }),
  );
  expect(marker?.label).toBe("Context handoff");
  expect(marker?.from.map((side) => side.provider)).toEqual(["codex", "opencode"]);
  expect(marker?.from[0]?.name).toBe("GPT-5 Codex");
  expect(marker?.to).toMatchObject({ provider: "claude", name: "Opus 4.1" });
  expect(marker?.text).toBe(`Context handoff: GPT-5 Codex, ${marker?.from[1]?.name} → Opus 4.1`);
});

test("a handoff recorded before source lists names its one previous model", () => {
  const marker = handoffMarker(
    handoff({ from: { provider: "codex" }, to: { provider: "claude" } }, "{}"),
  );
  expect(marker?.text).toBe("Context handoff: Codex → Claude Code");
});

test("the person's words and handoffs without a target are not handoff markers", () => {
  expect(handoffMarker(message("user", "Switch to Claude", { origin: { kind: "person" } }))).toBe(
    undefined,
  );
  expect(handoffMarker(handoff({}))).toBeUndefined();
});

test("phones show the handoff as one quiet line, never the context ace sent", () => {
  const row = transcriptRowContent(
    handoff({ from: { provider: "codex" }, to: { provider: "claude", model: "claude-opus-4-1" } }),
  );
  expect(row).toMatchObject({
    text: "Context handoff: Codex → Opus 4.1",
    quiet: true,
    user: false,
  });
});
