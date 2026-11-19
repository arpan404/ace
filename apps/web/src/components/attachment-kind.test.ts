import { describe, expect, it } from "vitest";
import { describeFile } from "./attachment-kind.ts";

describe("describeFile", () => {
  it.each(["chart.png", "photo.JPG", "photo.jpeg", "loop.gif", "shot.webp", "pic.avif", "a.bmp"])(
    "a linked %s with no MIME type or daemon kind previews as an image",
    (name) => {
      expect(describeFile({ name }).preview).toBe("image");
    },
  );

  it("an image under an absolute path previews as an image", () => {
    expect(describeFile({ name: "/tmp/out/ace-benchmarks-final.png" }).preview).toBe("image");
  });

  it("an SVG reads as source, not a picture", () => {
    expect(describeFile({ name: "logo.svg" }).preview).toBe("text");
  });

  it("the daemon calling the bytes binary wins over an image name", () => {
    expect(describeFile({ name: "fake.png", kind: "binary" }).preview).toBe("none");
  });

  it.each([
    ["clip.mp4", "video"],
    ["song.mp3", "audio"],
    ["paper.pdf", "pdf"],
  ])("a linked %s opens in its viewer", (name, preview) => {
    expect(describeFile({ name }).preview).toBe(preview);
  });

  it.each(["Dockerfile", "Makefile", ".gitignore", ".env", "LICENSE", "app.conf", "fix.patch"])(
    "%s, known by name, opens as text",
    (name) => {
      expect(describeFile({ name }).preview).toBe("text");
    },
  );

  it("an unknown binary still offers only Download", () => {
    expect(describeFile({ name: "blob.bin" }).preview).toBe("none");
  });
});
