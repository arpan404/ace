import { describe, expect, it } from "vitest";
import { localCursor } from "./local-echo.ts";

describe("local cursor", () => {
  it("shows the page's cursor shape and the arrow for anything unknown", () => {
    expect(localCursor("pointer")).toBe("pointer");
    expect(localCursor(" Text ")).toBe("text");
    expect(localCursor(undefined)).toBe("default");
    expect(localCursor("auto")).toBe("default");
    expect(localCursor("url(evil.png), pointer")).toBe("default");
  });
});
