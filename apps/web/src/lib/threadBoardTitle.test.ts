import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { buildThreadBoardTitle } from "./threadBoardTitle";

describe("buildThreadBoardTitle", () => {
  it("builds compact board names from thread titles", () => {
    expect(
      buildThreadBoardTitle({
        fallbackIndex: 3,
        threads: [
          { threadId: ThreadId.makeUnsafe("thread-a"), title: "Audit codebase" },
          { threadId: ThreadId.makeUnsafe("thread-b"), title: "Rust port" },
        ],
      }),
    ).toBe("Audit codebase + 1");
  });

  it("falls back to an indexed board name when titles are unavailable", () => {
    expect(
      buildThreadBoardTitle({
        fallbackIndex: 4,
        threads: [
          { threadId: ThreadId.makeUnsafe("thread-a") },
          { threadId: ThreadId.makeUnsafe("thread-b"), title: " " },
        ],
      }),
    ).toBe("Board 4");
  });
});
