import { describe, expect, it } from "vitest";
import { describeFile, unknownKind } from "./attachment-kind.ts";

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

  it.each([
    ["icon.ico", "image/x-icon"],
    ["photo.avif", "image/avif"],
    ["old.bmp", "image/bmp"],
  ])("%s, a picture the daemon never inspects, still tries the image viewer", (name, mimeType) => {
    expect(describeFile({ name, mimeType, kind: "binary" }).preview).toBe("image");
  });

  it.each([
    ["huge.png", "image/png"],
    ["cut.jpg", "image/jpeg"],
    ["fake.png", "application/octet-stream"],
  ])("%s the daemon inspected and refused offers only Download", (name, mimeType) => {
    expect(describeFile({ name, mimeType, kind: "binary" }).preview).toBe("none");
  });

  it("a refused picture named like a video still offers only Download", () => {
    const file = { name: "capture.mp4", mimeType: "image/png", kind: "binary" } as const;
    expect(describeFile(file).preview).toBe("none");
  });

  it("a declared text type wins over an image name", () => {
    expect(describeFile({ name: "notes.png", mimeType: "text/plain" }).preview).toBe("text");
  });

  it("a file named after an Object property is not an image", () => {
    expect(describeFile({ name: "constructor" }).preview).toBe("none");
    expect(unknownKind({ name: "notes.constructor" })).toBe(true);
  });

  it.each([
    ["photo.heic", "image/heic"],
    ["scan.tiff", "image/tiff"],
  ])("%s, which the browser can't draw, offers only Download", (name, mimeType) => {
    expect(describeFile({ name, mimeType }).preview).toBe("none");
  });

  it("text the daemon validated stays text whatever its name says", () => {
    expect(describeFile({ name: "notes.png", kind: "text" }).preview).toBe("text");
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

describe("unknownKind", () => {
  it("a linked file of no known type is worth reading to see if it is text", () => {
    expect(unknownKind({ name: "CHANGELOG" })).toBe(true);
    expect(unknownKind({ name: "go.mod" })).toBe(true);
  });

  it("a file the daemon or its type already placed is not", () => {
    expect(unknownKind({ name: "blob.bin", kind: "binary" })).toBe(false);
    expect(unknownKind({ name: "bundle.zip" })).toBe(false);
    expect(unknownKind({ name: "chart.png" })).toBe(false);
  });
});
