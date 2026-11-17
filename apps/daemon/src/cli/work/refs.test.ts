import { describe, expect, test } from "vitest";
import { CliFailure } from "../output.ts";
import { resolveRef, shortIds, threadNoun } from "./refs.ts";

const known = ["t_9f2c41aa", "t_9f2c41bb", "t_7d00e1cc"];

function failure(run: () => unknown): CliFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof CliFailure) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("thread and request references", () => {
  test.each([
    { input: "t_9f2c41aa", expected: "t_9f2c41aa", why: "a whole id" },
    { input: "t_7d00e", expected: "t_7d00e1cc", why: "an unambiguous prefix of six or more" },
    { input: " t_9f2c41bb ", expected: "t_9f2c41bb", why: "surrounding spaces" },
  ])("$why names its thread", ({ input, expected }) => {
    expect(resolveRef(input, known, threadNoun)).toBe(expected);
  });

  test("a prefix two threads share fails naming both, as a usage error", () => {
    const error = failure(() => resolveRef("t_9f2c41", known, threadNoun));
    expect(error.outcome).toBe("usage");
    expect(error.detail.code).toBe("ambiguous");
    expect(error.message).toContain("t_9f2c41aa");
    expect(error.message).toContain("t_9f2c41bb");
  });

  test("fewer than six characters is a usage error naming the argument", () => {
    const error = failure(() => resolveRef("t_9f", known, threadNoun));
    expect(error.outcome).toBe("usage");
    expect(error.detail.argument).toBe("THREAD");
  });

  test("an unknown prefix is not found, unless the caller lets a whole id through", () => {
    expect(failure(() => resolveRef("t_000000", known, threadNoun)).detail.code).toBe("not_found");
    expect(resolveRef("t_child99", known, threadNoun, () => true)).toBe("t_child99");
  });

  test("short ids are as short as eight characters and never shared", () => {
    const short = shortIds(known);
    expect(short.get("t_7d00e1cc")).toBe("t_7d00e1");
    expect(short.get("t_9f2c41aa")).toBe("t_9f2c41a");
    expect(short.get("t_9f2c41bb")).toBe("t_9f2c41b");
    for (const [id, prefix] of short) expect(resolveRef(prefix, known, threadNoun)).toBe(id);
  });
});
