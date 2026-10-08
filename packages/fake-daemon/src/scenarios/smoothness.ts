import type { Fact, Key } from "@ace/core";
import type { InteractionMeasurement, StepMeasurement } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

/** A tiny four-frame JPEG standing in for a measurement's filmstrip grid. */
export const filmstripJpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERX" +
  "RTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj" +
  "Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAYAGADASIAAhEBAxEB/8QAGQABAQEBAQEAAAAAAAAAAAAA" +
  "AAIGBQQB/8QAKhAAAQMCBAYCAgMAAAAAAAAAAgABAxESE0JRsQQGNWJzkjOCBTTBwtL/xAAXAQEBAQEAAAAAAAAA" +
  "AAAAAAAAAgMB/8QAGhEAAwEBAQEAAAAAAAAAAAAAAAERAgMSIf/aAAwDAQACEQMRAD8A20UYmFxXVq+Z9VeAHd7O" +
  "stzB+5H4/wC5Lq8r9Ok8r7MtXymPVIWvsOjLGIBcN1atmfVIoxMLiurV8z6q5/i+zbsvPxPSeJ8cn8rNKuFnowA7" +
  "vZ1EsYgFw3Vq2Z9Vjfx/UeF8obstrP8AF9m3ZadOfhyk516IijEwuK6tXzPqrwA7vZ0g+L7Pu6zXNHUY/E27qeeP" +
  "bg04qaKWMQC4bq1bM+qRRiYXFdWr5n1XK5f6TJ5/8rsQfF9n3dc1ny4dTqowA7vZ1EsYgFw3Vq2Z9V8/IdO4rxHs" +
  "6xvAfv8ADeUd2V8+XtN0nWo4bOKQQC0rq1fK+qvHDu9XRFkWRLIJhaN1atlfVIpBALSurV8r6oiAvHDu9XUSyCYW" +
  "jdWrZX1REAikEAtK6tXyvqrxw7vV0RARLIJhaN1atlfVIpBALSurV8r6oiAvHDu9XUSyCYWjdWrZX1REB//Z";

/**
 * A finished `screen_measure_interaction` (window targets) or `ace_browser_measure_interaction`
 * (tab targets) step as Codex stores it: the MCP result's JSON text part, then the filmstrip's
 * image part unless `filmstrip` is false.
 */
export function measurementCall(
  agent: Key,
  item: Key,
  measurement: InteractionMeasurement,
  options: { filmstrip?: boolean } = {},
): Fact {
  const tool =
    measurement.target.kind === "window"
      ? "screen_measure_interaction"
      : "ace_browser_measure_interaction";
  const content = [
    { type: "text", text: JSON.stringify(measurement) },
    ...(options.filmstrip === false
      ? []
      : [{ type: "image", mimeType: "image/jpeg", data: filmstripJpeg }]),
  ];
  const args = { observeMs: measurement.windowMs, repeat: measurement.repeat?.runs.length ?? 1 };
  return {
    type: "item.upsert",
    agent,
    item,
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: "mcp",
        title: tool,
        status: "succeeded",
        detail: { kind: "mcp", server: "ace", tool, arguments: args },
        raw: [
          {
            type: "mcpToolCall",
            name: tool,
            data: {
              type: "mcpToolCall",
              id: item,
              server: "ace",
              tool,
              status: "completed",
              arguments: args,
              result: { content },
            },
          },
        ],
      },
    },
  };
}

/** A modern daemon result, with no reliance on provider payloads. */
export function typedMeasurementCall(agent: Key, item: Key, measurement: StepMeasurement): Fact {
  const { filmstrip: _attachment, ...metrics } = measurement;
  const legacy = measurementCall(agent, item, metrics, { filmstrip: false });
  if (legacy.type !== "item.upsert" || legacy.draft.type !== "tool_call")
    throw new Error("Invalid measurement seed");
  return {
    ...legacy,
    draft: {
      ...legacy.draft,
      measurement,
      call: {
        ...legacy.draft.call,
        raw: [],
        result: {
          isError: false,
          durationMs: measurement.windowMs,
          content: [
            { type: "text", text: JSON.stringify(metrics) },
            ...(measurement.filmstrip
              ? [{ type: "image" as const, attachment: measurement.filmstrip }]
              : []),
          ],
          structuredContent: metrics,
        },
      },
    },
  };
}

const safari = { kind: "window", bundleId: "com.apple.Safari", windowId: 41 } as const;
const textEdit = { kind: "window", bundleId: "com.apple.TextEdit", windowId: 7 } as const;
const tab = { kind: "browser-tab", threadId: "thread-smoothness", tabId: "tab-1" } as const;

/** Fields every measurement shares; each case overrides what makes it that case. */
function measured(
  fields: Partial<InteractionMeasurement> &
    Pick<InteractionMeasurement, "verdict" | "confidence" | "target">,
): InteractionMeasurement {
  return {
    source: fields.target.kind === "window" ? "screen-frames" : "browser-trace",
    refreshHz: 120,
    windowMs: 2000,
    frames: 80,
    hitches: [],
    notes: [],
    ...fields,
  };
}

/** One of each verdict, a repeated run and a measurement taken while the host was busy. */
export const smoothnessCases = {
  smooth: measured({
    verdict: "smooth",
    confidence: "high",
    target: safari,
    action: { kind: "scroll", dx: 0, dy: -300 },
    latencyMs: 18,
    settleMs: 640,
    effectiveFps: 119.2,
    droppedFrames: 0,
    hitchRatioMsPerS: 0.8,
    hitchTimeMs: 0.5,
  }),
  minorHitches: measured({
    verdict: "minor_hitches",
    confidence: "high",
    target: tab,
    action: { action: "click", ref: "e12" },
    refreshHz: 60,
    latencyMs: 42,
    settleMs: 900,
    effectiveFps: 55,
    droppedFrames: 2,
    hitches: [{ atMs: 210, durationMs: 50 }],
    hitchRatioMsPerS: 7.4,
    hitchTimeMs: 33,
  }),
  janky: measured({
    verdict: "janky",
    confidence: "high",
    target: textEdit,
    action: { kind: "key.press", key: "K", modifiers: ["command"] },
    refreshHz: 60,
    latencyMs: 95,
    settleMs: 1500,
    effectiveFps: 38,
    droppedFrames: 14,
    hitches: [
      { atMs: 120, durationMs: 180 },
      { atMs: 600, durationMs: 66 },
    ],
    hitchRatioMsPerS: 24.5,
    hitchTimeMs: 213,
  }),
  noChange: measured({
    verdict: "no_change",
    confidence: "low",
    target: tab,
    action: { action: "press", key: "Escape" },
    frames: 0,
    notes: ["Too few content updates to assess continuous animation reliably."],
  }),
  inconclusive: measured({
    verdict: "inconclusive",
    confidence: "low",
    target: safari,
    frames: 4,
    notes: ["Too few content updates to assess continuous animation reliably."],
  }),
  repeated: measured({
    verdict: "minor_hitches",
    confidence: "high",
    target: tab,
    action: { action: "scroll", x: 0, y: 600 },
    refreshHz: 60,
    latencyMs: 25,
    settleMs: 700,
    effectiveFps: 54,
    hitches: [{ atMs: 300, durationMs: 40 }],
    hitchRatioMsPerS: 6.2,
    hitchTimeMs: 23,
    repeat: {
      runs: [
        { verdict: "smooth", confidence: "high" },
        { verdict: "minor_hitches", confidence: "high" },
        { verdict: "smooth", confidence: "high" },
      ],
      metrics: {
        refreshHz: { median: 60, worst: 60 },
        windowMs: { median: 2000, worst: 2000 },
        frames: { median: 70, worst: 64 },
        latencyMs: { median: 18, worst: 25 },
        settleMs: { median: 610, worst: 700 },
        effectiveFps: { median: 59, worst: 54 },
        hitchRatioMsPerS: { median: 1.2, worst: 6.2 },
        hitchMs: { median: 4, worst: 23 },
      },
    },
  }),
  busyHost: measured({
    verdict: "minor_hitches",
    confidence: "low",
    target: safari,
    action: { kind: "pointer.drag", x: 10, y: 10, toX: 400, toY: 10, button: "left" },
    latencyMs: 30,
    effectiveFps: 101,
    hitches: [{ atMs: 400, durationMs: 30 }],
    hitchRatioMsPerS: 8.1,
    hitchTimeMs: 22,
    hostLoad: 22,
    notes: [
      "Host one-minute load exceeds logical cores; host contention may cause hitches.",
      "Content did not remain still for 250 ms before the window ended.",
    ],
  }),
} satisfies Record<string, InteractionMeasurement>;

/** A finished turn whose work log holds every case; only the busy host's has no filmstrip. */
export function smoothnessMeasurements(): Scenario {
  return {
    thread: {
      id: "thread-smoothness",
      workspaceId: "ace",
      title: "Check the sheet's smoothness",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "measured",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Is scrolling the sheet smooth now?"),
          ...Object.entries(smoothnessCases).map(([key, measurement]) =>
            measurementCall("root", key, measurement, { filmstrip: key !== "busyHost" }),
          ),
          message("root", "answer", "assistant", "Scrolling is smooth; the click still hitches."),
          endTurn("root"),
        ],
      },
    ],
  };
}
