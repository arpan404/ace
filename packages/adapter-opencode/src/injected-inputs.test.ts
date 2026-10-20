import { expect, it } from "vitest";
import { harness } from "./replay.ts";

/* OpenCode v2 writes a finished background shell or child as a synthetic message for the model
 * (opencode 2.0.30, as stored by the daemon). It is the session's input, never the agent's prose. */
function replay(message: Record<string, unknown>) {
  const h = harness();
  let seq = 0;
  const frame = (channel: string, data: unknown, dir: "recv" | "send" | "note" = "recv") =>
    h.feed({ seq: seq++, t: seq, dir, channel, data });
  frame("lifecycle", { type: "started" }, "note");
  frame("sse", {
    id: "e0",
    created: 0,
    type: "session.created",
    data: { sessionID: "ses_root", projectID: "p", location: { directory: "/one" } },
    location: { directory: "/one" },
  });
  frame("snapshot.message", { sessionID: "ses_root", message });
  return Object.values(h.view.items).filter((item) => item.type === "message");
}

const shell = `<shell id="sh_147d2cdec001M0xrJeYsu7l5wt" state="completed" command="git diff --stat">
 2 files changed, 9 insertions(+)

</shell>`;

it("a finished background shell OpenCode injects is a background-completion input", () => {
  expect(
    replay({
      id: "msg_147d2cdee002TLt8p7m1pG1csD",
      type: "synthetic",
      metadata: {
        source: "shell",
        shellID: "sh_147d2cdec001M0xrJeYsu7l5wt",
        jobID: "sh_147d2cdec001M0xrJeYsu7l5wt",
        state: "completed",
        truncated: false,
        exit: 0,
      },
      time: { created: 1792206366908 },
      text: shell,
      description: "git diff --stat",
    }),
  ).toEqual([
    expect.objectContaining({
      role: "user",
      synthetic: true,
      origin: { kind: "background_completion" },
      parts: [{ type: "text", text: shell }],
    }),
  ]);
});

it("a child's result OpenCode injects is a subagent-result input", () => {
  expect(
    replay({
      id: "msg_148012f3a001SG4FImEfvXBpC9",
      type: "synthetic",
      metadata: {
        source: "subagent",
        childID: "ses_eb7fed12dffeNStaf7L2JRNrPd",
        agent: "General",
        state: "completed",
      },
      time: { created: 1792209848420 },
      text: '<subagent sessionID="ses_eb7fed12dffeNStaf7L2JRNrPd" state="completed" description="Audit">\nAll verification complete.\n\n</subagent>',
    }),
  ).toEqual([
    expect.objectContaining({
      role: "user",
      synthetic: true,
      origin: { kind: "subagent_result" },
    }),
  ]);
});

it("a synthetic message from a source ace doesn't know stays unclassified input", () => {
  const [item] = replay({
    id: "msg_instructions",
    type: "synthetic",
    metadata: { source: "instructions" },
    time: { created: 1 },
    text: "Instructions from AGENTS.md",
  });
  expect(item).toMatchObject({ role: "user", synthetic: true });
  expect(item).not.toHaveProperty("origin");
});
