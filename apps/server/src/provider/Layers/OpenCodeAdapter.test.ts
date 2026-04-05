import { describe, expect, it } from "vitest";

import {
  appendOnlyDelta,
  buildOpenCodeThreadUsageSnapshot,
  classifyOpenCodeDeltaStreamKind,
  classifyOpenCodeToolItemType,
  mapOpenCodeTodoStatus,
  openCodeTimestampToIso,
  resolveOpenCodeDeltaStreamKind,
  resolveOpenCodePartTimestamp,
} from "./OpenCodeAdapter.ts";

describe("classifyOpenCodeToolItemType", () => {
  it("maps shell-style tools to command execution activities", () => {
    expect(classifyOpenCodeToolItemType("bash")).toBe("command_execution");
  });

  it("maps edit tools to file change activities", () => {
    expect(classifyOpenCodeToolItemType("write")).toBe("file_change");
  });

  it("defaults unknown tools to dynamic tool calls", () => {
    expect(classifyOpenCodeToolItemType("glob")).toBe("dynamic_tool_call");
  });
});

describe("appendOnlyDelta", () => {
  it("returns only the appended suffix when text streams forward", () => {
    expect(appendOnlyDelta("hello", "hello world")).toBe(" world");
  });

  it("falls back to the full next value when the stream resets", () => {
    expect(appendOnlyDelta("hello world", "world")).toBe("world");
  });
});

describe("classifyOpenCodeDeltaStreamKind", () => {
  it("routes reasoning content deltas into streamed thinking", () => {
    expect(classifyOpenCodeDeltaStreamKind("reasoning_content")).toBe("reasoning_text");
  });

  it("routes reasoning summary deltas into streamed thinking summaries", () => {
    expect(classifyOpenCodeDeltaStreamKind("reasoning_details")).toBe("reasoning_summary_text");
  });

  it("keeps non-reasoning deltas as assistant text", () => {
    expect(classifyOpenCodeDeltaStreamKind("text")).toBe("assistant_text");
    expect(classifyOpenCodeDeltaStreamKind(undefined)).toBe("assistant_text");
  });
});

describe("resolveOpenCodeDeltaStreamKind", () => {
  it("keeps known reasoning parts in the reasoning stream when deltas are ambiguous", () => {
    expect(resolveOpenCodeDeltaStreamKind({ field: "text", isReasoningPart: true })).toBe(
      "reasoning_text",
    );
    expect(resolveOpenCodeDeltaStreamKind({ field: undefined, isReasoningPart: true })).toBe(
      "reasoning_text",
    );
  });

  it("preserves explicit stream kind fields and normal assistant text routing", () => {
    expect(
      resolveOpenCodeDeltaStreamKind({ field: "reasoning_details", isReasoningPart: true }),
    ).toBe("reasoning_summary_text");
    expect(resolveOpenCodeDeltaStreamKind({ field: "text", isReasoningPart: false })).toBe(
      "assistant_text",
    );
  });
});

describe("mapOpenCodeTodoStatus", () => {
  it("translates OpenCode todo states into orchestration plan statuses", () => {
    expect(mapOpenCodeTodoStatus("pending")).toBe("pending");
    expect(mapOpenCodeTodoStatus("in_progress")).toBe("inProgress");
    expect(mapOpenCodeTodoStatus("completed")).toBe("completed");
    expect(mapOpenCodeTodoStatus("cancelled")).toBe("completed");
  });
});

describe("openCodeTimestampToIso", () => {
  it("normalizes OpenCode epoch timestamps into ISO datetimes", () => {
    expect(openCodeTimestampToIso(1_742_533_200)).toBe(new Date(1_742_533_200_000).toISOString());
    expect(openCodeTimestampToIso("1742533200456")).toBe(new Date(1_742_533_200_456).toISOString());
  });

  it("ignores values that do not look like absolute timestamps", () => {
    expect(openCodeTimestampToIso(42)).toBeUndefined();
    expect(openCodeTimestampToIso("not-a-time")).toBeUndefined();
  });
});

describe("resolveOpenCodePartTimestamp", () => {
  it("reads provider part boundaries so reasoning can stay anchored in order", () => {
    const part = {
      time: {
        start: 1_742_533_200,
        end: "1742533200456",
      },
    };

    expect(resolveOpenCodePartTimestamp(part, "start")).toBe(
      new Date(1_742_533_200_000).toISOString(),
    );
    expect(resolveOpenCodePartTimestamp(part, "end")).toBe(
      new Date(1_742_533_200_456).toISOString(),
    );
  });
});

describe("buildOpenCodeThreadUsageSnapshot", () => {
  it("normalizes step-finish token accounting into thread usage details", () => {
    expect(
      buildOpenCodeThreadUsageSnapshot(
        {
          input: 900,
          output: 120,
          reasoning: 40,
          cache: {
            read: 60,
            write: 15,
          },
        },
        3,
      ),
    ).toEqual({
      usedTokens: 1_135,
      lastUsedTokens: 1_135,
      lastInputTokens: 900,
      lastCachedInputTokens: 75,
      lastOutputTokens: 120,
      lastReasoningOutputTokens: 40,
      toolUses: 3,
      compactsAutomatically: true,
    });
  });

  it("prefers an explicit total when OpenCode provides one", () => {
    expect(
      buildOpenCodeThreadUsageSnapshot({
        total: 2_048,
        input: 1_100,
        output: 300,
      }),
    ).toEqual({
      usedTokens: 2_048,
      lastUsedTokens: 2_048,
      lastInputTokens: 1_100,
      lastOutputTokens: 300,
      compactsAutomatically: true,
    });
  });

  it("returns undefined when the provider reports no positive usage", () => {
    expect(buildOpenCodeThreadUsageSnapshot({ input: 0, output: 0 })).toBeUndefined();
    expect(buildOpenCodeThreadUsageSnapshot(undefined)).toBeUndefined();
  });
});
