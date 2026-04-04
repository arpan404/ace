import { describe, expect, it } from "vitest";

import {
  classifyCursorToolItemType,
  describePermissionRequest,
  extractCursorStreamText,
  permissionOptionIdForRuntimeMode,
  requestTypeForCursorTool,
  runtimeItemStatusFromCursorStatus,
  streamKindFromUpdateKind,
} from "./CursorAdapter";

describe("permissionOptionIdForRuntimeMode", () => {
  it("auto-approves Cursor ACP tool permissions for full-access sessions", () => {
    expect(permissionOptionIdForRuntimeMode("full-access")).toEqual({
      primary: "allow-always",
      decision: "acceptForSession",
    });
  });

  it("keeps manual approval flow for approval-required sessions", () => {
    expect(permissionOptionIdForRuntimeMode("approval-required")).toEqual({
      primary: "allow-once",
      decision: "accept",
    });
  });
});

describe("streamKindFromUpdateKind", () => {
  it("maps Cursor thought chunks to reasoning text", () => {
    expect(streamKindFromUpdateKind("agent_thought_chunk")).toBe("reasoning_text");
  });

  it("keeps normal assistant chunks as assistant text", () => {
    expect(streamKindFromUpdateKind("agent_message_chunk")).toBe("assistant_text");
  });
});

describe("extractCursorStreamText", () => {
  it("preserves leading and trailing whitespace for streamed chunks", () => {
    expect(extractCursorStreamText({ content: { text: "  hello world  \n" } })).toBe(
      "  hello world  \n",
    );
  });

  it("keeps whitespace-only streamed chunks instead of trimming them away", () => {
    expect(extractCursorStreamText({ text: "   " })).toBe("   ");
  });
});

describe("classifyCursorToolItemType", () => {
  it("classifies execute/terminal tool calls as command execution", () => {
    expect(
      classifyCursorToolItemType({
        kind: "execute",
        title: "Terminal",
      }),
    ).toBe("command_execution");
  });

  it("classifies explore subagent tasks as collab agent tool calls", () => {
    expect(
      classifyCursorToolItemType({
        title: "Explore codebase",
        subagentType: "explore",
      }),
    ).toBe("collab_agent_tool_call");
  });
});

describe("requestTypeForCursorTool", () => {
  it("classifies read-style tools as file-read approvals", () => {
    expect(
      requestTypeForCursorTool({
        kind: "read",
        title: "Read file",
      }),
    ).toBe("file_read_approval");
  });
});

describe("runtimeItemStatusFromCursorStatus", () => {
  it("normalizes Cursor in-progress and completed statuses", () => {
    expect(runtimeItemStatusFromCursorStatus("in_progress")).toBe("inProgress");
    expect(runtimeItemStatusFromCursorStatus("completed")).toBe("completed");
    expect(runtimeItemStatusFromCursorStatus("failed")).toBe("failed");
  });
});

describe("describePermissionRequest", () => {
  it("extracts the command text from Cursor permission requests", () => {
    expect(
      describePermissionRequest({
        toolCall: {
          toolCallId: "tool_123",
          title: "`pwd && ls -la /tmp/repo`",
          kind: "execute",
          status: "pending",
        },
      }),
    ).toBe("pwd && ls -la /tmp/repo");
  });
});
