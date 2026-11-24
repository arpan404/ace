import { describe, expect, it } from "vitest";
import { binaryMime } from "./file-kind.ts";

describe("binaryMime", () => {
  it.each([
    ["clip.m4v", "video/x-m4v"],
    ["clip.MOV", "video/quicktime"],
    ["clip.mp4", "video/mp4"],
  ])("resolves %s to a video type even when the sender said it was generic", (name, mime) => {
    expect(binaryMime(name, "application/octet-stream")).toBe(mime);
  });

  it("keeps a declared type for an unknown extension and falls back to generic binary otherwise", () => {
    expect(binaryMime("a.xyz", "video/webm")).toBe("video/webm");
    expect(binaryMime("a.xyz")).toBe("application/octet-stream");
  });
});
