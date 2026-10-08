import type { Frame } from "@ace/engine-api";

/** Synthetic v2 frames reproducing mixed history after a new prompt. No provider is launched. */
export function historyReplyFrames(): { initial: Frame[]; next: Frame[] } {
  let sequence = 0;
  const frame = (channel: string, data: unknown, dir: Frame["dir"] = "recv"): Frame => ({
    seq: ++sequence,
    t: sequence,
    channel,
    data,
    dir,
  });
  const event = (type: string, data: Record<string, unknown> = {}) =>
    frame("sse", { id: `event-${sequence}`, type, data: { sessionID: "native-1", ...data } });
  const info = frame("snapshot.info", {
    root: true,
    info: { id: "native-1", projectID: "project", location: { directory: "/project" } },
  });
  const initial = [
    info,
    event("session.execution.started"),
    event("session.reasoning.ended", { assistantMessageID: "answer", ordinal: 0, text: "Think" }),
    event("session.text.ended", {
      assistantMessageID: "answer",
      ordinal: 0,
      text: "Delegation summary",
    }),
    event("session.execution.succeeded"),
  ];
  const next = [
    frame(
      "http",
      {
        method: "POST",
        path: "/api/session/native-1/prompt",
        body: { id: "next-input", text: "List downloads" },
      },
      "send",
    ),
  ];
  for (let replay = 0; replay < 2; replay++)
    next.push(
      frame("snapshot.message", {
        sessionID: "native-1",
        message: {
          id: "answer",
          type: "assistant",
          time: { completed: 10 },
          content: [
            { type: "reasoning", text: "Think" },
            { type: "text", text: "Delegation summary" },
          ],
        },
      }),
    );
  next.push(event("session.execution.started"));
  return { initial, next };
}
