import { describe, expect, it } from "vitest";

import {
  appendOnlyDelta,
  buildOpenCodeThreadUsageSnapshot,
  classifyOpenCodeDeltaStreamKind,
  isOpenCodeRetryStatusError,
  classifyOpenCodeToolItemType,
  isMissingOpenCodeSessionError,
  mapOpenCodeTodoStatus,
  mapOpenCodePermissionReplyDecision,
  mapOpenCodeQuestionAnswers,
  openCodePermissionRulesForRuntimeMode,
  openCodeTimestampToIso,
  openCodeTimestampToEpochMs,
  rankOpenCodeToolStateStatus,
  readOpenCodeEventRequestId,
  readOpenCodeResumeSessionId,
  resolveOpenCodeDeltaStreamKind,
  resolveOpenCodePartTimestamp,
  shouldEmitOpenCodeSnapshotDelta,
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

describe("isOpenCodeRetryStatusError", () => {
  it("treats rate-limit retry warnings as provider errors", () => {
    expect(
      isOpenCodeRetryStatusError({
        type: "retry",
        attempt: 1,
        message: "Free usage exceeded, subscribe to Go https://opencode.ai/go",
      }),
    ).toBe(true);
    expect(
      isOpenCodeRetryStatusError({
        type: "retry",
        code: 429,
        message: "Please retry later",
      }),
    ).toBe(true);
  });

  it("keeps transient retry warnings non-fatal", () => {
    expect(
      isOpenCodeRetryStatusError({
        type: "retry",
        attempt: 2,
        message: "Connection dropped, retrying shortly",
      }),
    ).toBe(false);
    expect(
      isOpenCodeRetryStatusError({
        type: "ready",
        message: "Free usage exceeded",
      }),
    ).toBe(false);
  });
});

describe("shouldEmitOpenCodeSnapshotDelta", () => {
  it("suppresses snapshot deltas after native stream deltas were seen", () => {
    expect(
      shouldEmitOpenCodeSnapshotDelta({
        hasNativeDelta: true,
        previousLength: 4,
        nextLength: 8,
      }),
    ).toBe(false);
  });

  it("suppresses regressive snapshots and only emits append-only growth", () => {
    expect(
      shouldEmitOpenCodeSnapshotDelta({
        hasNativeDelta: false,
        previousLength: 8,
        nextLength: 4,
      }),
    ).toBe(false);
    expect(
      shouldEmitOpenCodeSnapshotDelta({
        hasNativeDelta: false,
        previousLength: 8,
        nextLength: 8,
      }),
    ).toBe(false);
    expect(
      shouldEmitOpenCodeSnapshotDelta({
        hasNativeDelta: false,
        previousLength: 8,
        nextLength: 12,
      }),
    ).toBe(true);
  });
});

describe("rankOpenCodeToolStateStatus", () => {
  it("keeps tool statuses monotonic so stale snapshots cannot regress timeline order", () => {
    expect(rankOpenCodeToolStateStatus("pending")).toBeLessThan(
      rankOpenCodeToolStateStatus("running"),
    );
    expect(rankOpenCodeToolStateStatus("running")).toBeLessThan(
      rankOpenCodeToolStateStatus("completed"),
    );
    expect(rankOpenCodeToolStateStatus("error")).toBe(rankOpenCodeToolStateStatus("completed"));
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

describe("readOpenCodeEventRequestId", () => {
  it("prefers id but falls back to requestID and requestId", () => {
    expect(
      readOpenCodeEventRequestId({ id: "req-1", requestID: "req-2", requestId: "req-3" }),
    ).toBe("req-1");
    expect(readOpenCodeEventRequestId({ requestID: "req-2" })).toBe("req-2");
    expect(readOpenCodeEventRequestId({ requestId: "req-3" })).toBe("req-3");
  });

  it("returns undefined for missing ids", () => {
    expect(readOpenCodeEventRequestId({})).toBeUndefined();
    expect(readOpenCodeEventRequestId({ id: 123 })).toBeUndefined();
  });
});

describe("openCodePermissionRulesForRuntimeMode", () => {
  it("enables a wildcard allow rule for full-access mode", () => {
    expect(openCodePermissionRulesForRuntimeMode("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("keeps approval-required mode on OpenCode defaults", () => {
    expect(openCodePermissionRulesForRuntimeMode("approval-required")).toBeUndefined();
  });
});

describe("mapOpenCodePermissionReplyDecision", () => {
  it("maps OpenCode permission replies to canonical decisions", () => {
    expect(mapOpenCodePermissionReplyDecision("once")).toBe("accept");
    expect(mapOpenCodePermissionReplyDecision("always")).toBe("acceptForSession");
    expect(mapOpenCodePermissionReplyDecision("reject")).toBe("decline");
  });
});

describe("mapOpenCodeQuestionAnswers", () => {
  it("maps positional OpenCode answers to question-id keyed answers", () => {
    expect(mapOpenCodeQuestionAnswers(["q-0", "q-1"], [["a"], ["b1", "b2"]])).toEqual({
      "q-0": ["a"],
      "q-1": ["b1", "b2"],
    });
  });

  it("fills missing answers with empty string arrays for deterministic shape", () => {
    expect(mapOpenCodeQuestionAnswers(["q-0", "q-1"], [["a"]])).toEqual({
      "q-0": ["a"],
      "q-1": [""],
    });
    expect(mapOpenCodeQuestionAnswers(["q-0"], undefined)).toEqual({
      "q-0": [""],
    });
  });
});

describe("readOpenCodeResumeSessionId", () => {
  it("extracts session ids from both string and object cursor formats", () => {
    expect(readOpenCodeResumeSessionId("session-abc")).toBe("session-abc");
    expect(readOpenCodeResumeSessionId({ sessionId: "session-def" })).toBe("session-def");
    expect(readOpenCodeResumeSessionId({ sessionID: "session-ghi" })).toBe("session-ghi");
    expect(readOpenCodeResumeSessionId({ id: "session-jkl" })).toBe("session-jkl");
  });

  it("returns undefined for invalid or empty cursor values", () => {
    expect(readOpenCodeResumeSessionId("")).toBeUndefined();
    expect(readOpenCodeResumeSessionId({ sessionId: "" })).toBeUndefined();
    expect(readOpenCodeResumeSessionId({})).toBeUndefined();
    expect(readOpenCodeResumeSessionId(null)).toBeUndefined();
  });
});

describe("isMissingOpenCodeSessionError", () => {
  it("detects 404/not-found OpenCode errors", () => {
    expect(
      isMissingOpenCodeSessionError({
        name: "NotFoundError",
        data: { message: "Session not found" },
      }),
    ).toBe(true);
    expect(isMissingOpenCodeSessionError({ status: 404 })).toBe(true);
    expect(isMissingOpenCodeSessionError("session not found")).toBe(true);
  });

  it("does not treat other failures as missing-session errors", () => {
    expect(
      isMissingOpenCodeSessionError({
        name: "InternalError",
        data: { message: "Something broke" },
      }),
    ).toBe(false);
    expect(isMissingOpenCodeSessionError(undefined)).toBe(false);
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

describe("openCodeTimestampToEpochMs", () => {
  it("normalizes OpenCode second and millisecond epochs", () => {
    expect(openCodeTimestampToEpochMs(1_742_533_200)).toBe(1_742_533_200_000);
    expect(openCodeTimestampToEpochMs("1742533200456")).toBe(1_742_533_200_456);
  });

  it("returns undefined for non-absolute and invalid timestamps", () => {
    expect(openCodeTimestampToEpochMs(42)).toBeUndefined();
    expect(openCodeTimestampToEpochMs("not-a-time")).toBeUndefined();
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
