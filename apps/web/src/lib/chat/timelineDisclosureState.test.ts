import { describe, expect, it } from "vitest";

import {
  commandOutputDisclosureKey,
  completedWorkDetailGroupDisclosureKey,
  completedWorkSummaryDisclosureKey,
  pruneTimelineDisclosureExpansionState,
  timelineDisclosureRevisionKey,
  toggleTimelineDisclosureExpansion,
  workDetailDisclosureKey,
  workGroupDisclosureKey,
  type TimelineDisclosureKey,
} from "./timelineDisclosureState";

describe("timeline disclosure keys", () => {
  it("normalizes simple keys without double-prefixing row ids", () => {
    expect(workGroupDisclosureKey("abc")).toBe("work-group:abc");
    expect(workGroupDisclosureKey("work-group:abc")).toBe("work-group:abc");
    expect(completedWorkSummaryDisclosureKey("turn-1")).toBe("completed-work-summary:turn-1");
    expect(completedWorkSummaryDisclosureKey("completed-work-summary:turn-1")).toBe(
      "completed-work-summary:turn-1",
    );
    expect(commandOutputDisclosureKey("command-output:cmd-1")).toBe("command-output:cmd-1");
    expect(workDetailDisclosureKey("work-detail:work-1")).toBe("work-detail:work-1");
  });

  it("normalizes completed-work detail group parts before composing the key", () => {
    expect(
      completedWorkDetailGroupDisclosureKey("completed-work-summary:turn-1", "work-group:tools"),
    ).toBe("completed-work-detail-group:turn-1:tools");
  });
});

describe("timeline disclosure expansion state", () => {
  it("toggles closed disclosures open and default-open disclosures closed", () => {
    const opened = toggleTimelineDisclosureExpansion({}, workGroupDisclosureKey("tools"));
    expect(opened).toEqual({ "work-group:tools": true });

    const closed = toggleTimelineDisclosureExpansion({}, workDetailDisclosureKey("error"), true);
    expect(closed).toEqual({ "work-detail:error": false });
  });

  it("prunes only keys that no longer belong to rendered rows", () => {
    const keep = workGroupDisclosureKey("keep");
    const drop = workGroupDisclosureKey("drop");
    const state = {
      [keep]: true,
      [drop]: true,
    };

    expect(
      pruneTimelineDisclosureExpansionState(state, new Set<TimelineDisclosureKey>([keep])),
    ).toEqual({
      [keep]: true,
    });
  });

  it("includes explicit false overrides in revision keys", () => {
    expect(timelineDisclosureRevisionKey({ [workDetailDisclosureKey("error")]: false })).toBe(
      "work-detail:error:0",
    );
  });
});
