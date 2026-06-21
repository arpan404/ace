import { EventId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { appendCompactedThreadActivity } from "./orchestrationThreadActivities";

describe("appendCompactedThreadActivity", () => {
  it("orders sequenced activities ahead of legacy activities without sequence", () => {
    const activities = appendCompactedThreadActivity(
      [
        {
          id: EventId.makeUnsafe("legacy-activity"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Legacy activity",
          payload: {},
          turnId: null,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      ],
      {
        id: EventId.makeUnsafe("sequenced-activity"),
        tone: "tool",
        kind: "tool.started",
        summary: "Sequenced activity",
        payload: {},
        turnId: null,
        sequence: 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      },
    );

    expect(activities.map((activity) => activity.id)).toEqual([
      "sequenced-activity",
      "legacy-activity",
    ]);
  });

  it("keeps earlier legacy activities ahead of later sequenced reasoning activity", () => {
    const activities = appendCompactedThreadActivity(
      [
        {
          id: EventId.makeUnsafe("tool-history"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Read file",
          payload: { detail: "packages/contracts/src/model.ts" },
          turnId: null,
          createdAt: "2026-03-05T10:00:00.500Z",
        },
      ],
      {
        id: EventId.makeUnsafe("reasoning-749"),
        tone: "info",
        kind: "reasoning.completed",
        summary: "Reasoning",
        payload: {
          taskId: "copilot-task-1",
          detail: "thought-749",
        },
        turnId: null,
        sequence: 750,
        createdAt: "2026-03-05T10:00:30.000Z",
      },
    );

    expect(activities.map((activity) => activity.id)).toEqual(["tool-history", "reasoning-749"]);
  });

  it("merges ordered reasoning updates for the same task into the trailing activity", () => {
    const activities = appendCompactedThreadActivity(
      [
        {
          id: EventId.makeUnsafe("tool-history"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Read file",
          payload: { detail: "package.json" },
          turnId: null,
          createdAt: "2026-03-05T10:00:00.500Z",
        },
        {
          id: EventId.makeUnsafe("reasoning-1"),
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning",
          payload: {
            taskId: "copilot-task-1",
            detail: "Inspecting package scripts.",
          },
          turnId: null,
          sequence: 10,
          createdAt: "2026-03-05T10:00:01.000Z",
        },
      ],
      {
        id: EventId.makeUnsafe("reasoning-2"),
        tone: "info",
        kind: "task.progress",
        summary: "Reasoning",
        payload: {
          taskId: "copilot-task-1",
          detail: "Inspecting package scripts before patching.",
        },
        turnId: null,
        sequence: 11,
        createdAt: "2026-03-05T10:00:02.000Z",
      },
    );

    expect(activities).toHaveLength(2);
    expect(activities[0]?.id).toBe("tool-history");
    expect(activities[1]).toMatchObject({
      id: "reasoning-2",
      kind: "task.progress",
      payload: {
        taskId: "copilot-task-1",
        detail: "Inspecting package scripts. Inspecting package scripts before patching.",
        description: "Inspecting package scripts. Inspecting package scripts before patching.",
      },
    });
  });
});
