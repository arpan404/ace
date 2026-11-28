import { describe, expect, it } from "vitest";
import { resolveComposerSubmitBehavior, shouldSubmitOnReturn } from "./composer-submit.ts";

describe("composer Return behavior", () => {
  it("sends on Return only when the person opted in", () => {
    expect(resolveComposerSubmitBehavior(true, false)).toBe("submit");
    expect(shouldSubmitOnReturn(true, false)).toBe(true);
  });

  it("inserts newlines by default", () => {
    expect(resolveComposerSubmitBehavior(false, false)).toBe("newline");
    expect(shouldSubmitOnReturn(false, false)).toBe(false);
  });

  it("keeps probe ownership of Return in fixture builds", () => {
    expect(resolveComposerSubmitBehavior(true, true)).toBe("submit");
    expect(resolveComposerSubmitBehavior(false, true)).toBe("submit");
    expect(shouldSubmitOnReturn(true, true)).toBe(false);
    expect(shouldSubmitOnReturn(false, true)).toBe(false);
  });
});
