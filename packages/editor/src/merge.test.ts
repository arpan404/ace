import { beforeAll, describe, expect, it } from "vitest";
import { merge3 } from "./merge.ts";
import { initForTests } from "./test-support.ts";

beforeAll(initForTests);

/** The Rust crate holds the full table; these check that both shapes cross the boundary. */
describe("merge3", () => {
  it("returns the merged text when the two sides changed different lines", () => {
    expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({
      clean: true,
      text: "A\nb\nC\n",
      chunks: [{ kind: "clean", text: "A\nb\nC\n" }],
    });
  });

  it("returns each conflicting block with the base and both sides, in order", () => {
    expect(merge3("a\r\nb\r\nc\r\n", "a\r\nmine\r\nc\r\n", "a\r\ntheirs\r\nc\r\n")).toEqual({
      clean: false,
      chunks: [
        { kind: "clean", text: "a\r\n" },
        { kind: "conflict", base: "b\r\n", mine: "mine\r\n", theirs: "theirs\r\n" },
        { kind: "clean", text: "c\r\n" },
      ],
    });
  });
});
