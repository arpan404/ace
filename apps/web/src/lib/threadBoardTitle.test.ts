import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { buildThreadBoardTitle, normalizeSplitTitle } from "./threadBoardTitle";

describe("buildThreadBoardTitle", () => {
  it("builds compact split names from thread titles", () => {
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

  it("falls back to an indexed split name when titles are unavailable", () => {
    expect(
      buildThreadBoardTitle({
        fallbackIndex: 4,
        threads: [
          { threadId: ThreadId.makeUnsafe("thread-a") },
          { threadId: ThreadId.makeUnsafe("thread-b"), title: " " },
        ],
      }),
    ).toBe("Split 4");
  });
});

describe("normalizeSplitTitle", () => {
  it("rewrites legacy default board titles to split titles", () => {
    expect(normalizeSplitTitle("Previous board")).toBe("Previous split");
    expect(normalizeSplitTitle("Untitled board")).toBe("Untitled split");
    expect(normalizeSplitTitle("Board 7")).toBe("Split 7");
  });
});
