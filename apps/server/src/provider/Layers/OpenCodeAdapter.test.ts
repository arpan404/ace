import { describe, expect, it } from "vitest";

import {
  appendOnlyDelta,
  classifyOpenCodeDeltaStreamKind,
  classifyOpenCodeToolItemType,
  mapOpenCodeTodoStatus,
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

describe("mapOpenCodeTodoStatus", () => {
  it("translates OpenCode todo states into orchestration plan statuses", () => {
    expect(mapOpenCodeTodoStatus("pending")).toBe("pending");
    expect(mapOpenCodeTodoStatus("in_progress")).toBe("inProgress");
    expect(mapOpenCodeTodoStatus("completed")).toBe("completed");
    expect(mapOpenCodeTodoStatus("cancelled")).toBe("completed");
  });
});
