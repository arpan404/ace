import { describe, expect, it } from "vitest";

import {
  hasProviderGoalLifecycleSignal,
  parseProviderGoalLifecycle,
} from "./providerGoalLifecycle";

describe("providerGoalLifecycle", () => {
  it("parses provider goal lifecycle tool output", () => {
    const payload = {
      itemType: "dynamic_tool_call",
      title: "Tool call",
      data: {
        item: {
          type: "function_call_output",
          name: "functions.update_goal",
          content: [
            { type: "text", text: "Goal updated" },
            { type: "text", text: "Keep goal state out of the transcript" },
          ],
          output: {
            status: "active",
            objective: "Keep goal state out of the transcript",
          },
        },
      },
    };

    expect(hasProviderGoalLifecycleSignal(payload)).toBe(true);
    expect(parseProviderGoalLifecycle(payload)).toEqual({
      action: "updated",
      status: "active",
      objective: "Keep goal state out of the transcript",
    });
  });

  it("parses provider goal clear lifecycle text", () => {
    expect(
      parseProviderGoalLifecycle({
        data: {
          item: {
            toolName: "thread/goal/clear",
            outputText: "Goal cleared",
            providerThreadId: "provider-thread-1",
          },
        },
      }),
    ).toEqual({
      action: "cleared",
      threadId: "provider-thread-1",
    });
  });

  it("detects provider goal state payloads without lifecycle label text", () => {
    const payload = {
      status: "paused",
      objective: "Keep goal state out of the transcript",
      tokensUsed: 42,
    };

    expect(hasProviderGoalLifecycleSignal(payload)).toBe(true);
    expect(parseProviderGoalLifecycle(payload)).toEqual({
      action: "updated",
      status: "paused",
      objective: "Keep goal state out of the transcript",
      tokensUsed: 42,
    });
  });

  it("extracts nested provider goal thread and usage metadata", () => {
    expect(
      parseProviderGoalLifecycle({
        summary: "Goal updated",
        payload: {
          data: {
            item: {
              result: {
                goal: {
                  threadId: "provider-thread-1",
                  objective: "Keep goal state out of the transcript",
                  status: "active",
                },
                tokensUsed: 7,
              },
            },
          },
        },
      }),
    ).toEqual({
      action: "updated",
      status: "active",
      threadId: "provider-thread-1",
      objective: "Keep goal state out of the transcript",
      tokensUsed: 7,
    });
  });
});
