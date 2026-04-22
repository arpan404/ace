import { describe, expect, it } from "vitest";

import {
  buildAgentAttentionNotificationTitle,
  buildApprovalNotificationBody,
  buildCompletionNotificationBody,
  buildUserInputNotificationBody,
  normalizeNotificationText,
  truncateNotificationText,
} from "./notifications";

describe("notification copy helpers", () => {
  it("builds thread-first attention titles", () => {
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "completion",
        threadTitle: "Build fixes",
      }),
    ).toBe("Build fixes finished");
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "approval",
        threadTitle: "Build fixes",
      }),
    ).toBe("Build fixes needs approval");
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "user-input",
        threadTitle: "",
      }),
    ).toBe("Untitled thread needs input");
  });

  it("normalizes markdown before truncating notification text", () => {
    expect(normalizeNotificationText("Run `[lint](/docs)`   then\n`bun run typecheck`")).toBe(
      "Run lint then bun run typecheck",
    );
    expect(truncateNotificationText("abcdef", 3)).toBe("abc");
  });

  it("builds actionable approval, user-input, and completion bodies", () => {
    expect(
      buildApprovalNotificationBody({
        requestKind: "command",
        detail: "bun lint",
      }),
    ).toBe("Command approval: bun lint");
    expect(
      buildApprovalNotificationBody({
        requestKind: "file-read",
      }),
    ).toBe("Review the file read approval request.");
    expect(
      buildUserInputNotificationBody({
        firstQuestion: "Which scope should I handle first?",
        questionCount: 2,
      }),
    ).toBe("Which scope should I handle first? (2 questions waiting)");
    expect(buildCompletionNotificationBody({ assistantPreview: "" })).toBe(
      "The agent finished working.",
    );
  });
});
