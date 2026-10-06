import { describe, expect, test } from "vitest";
import { projectAttachments, type ProjectionCapabilities } from "./index.ts";

const image = {
  path: "/repo/image one.png",
  name: "image one.png",
  mimeType: "image/png",
  base64: "YWJj",
};
const pdf = {
  path: "/repo/report.pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
  base64: "YWJj",
};
const text = {
  path: "/repo/main.ts",
  name: "main.ts",
  mimeType: "text/plain",
  text: "selected lines\n[ace: context truncated]",
};
function capabilities(provider: ProjectionCapabilities["provider"]): ProjectionCapabilities {
  return {
    provider,
    images: ["image/png"],
    documents: ["application/pdf"],
    embeddedContext: true,
    maxInlineBytes: 1000,
  };
}

describe("native attachment projection", () => {
  test("Claude carries a native PDF while preserving mention text", () => {
    expect(projectAttachments([text, image, pdf], capabilities("claude")).input).toEqual([
      { type: "text", text: text.text },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "YWJj" },
        title: "report.pdf",
        path: pdf.path,
      },
    ]);
  });
  test("ACP embeds negotiated PDF resources with the original bytes", () => {
    expect(projectAttachments([pdf], capabilities("acp")).input).toEqual([
      {
        type: "resource",
        resource: { uri: "file:///repo/report.pdf", mimeType: "application/pdf", blob: "YWJj" },
      },
    ]);
  });
  test.each(["claude", "codex", "opencode", "acp"] as const)(
    "%s exposes every unsupported file by absolute path",
    (provider) => {
      const result = projectAttachments(
        [
          pdf,
          {
            path: "/files/binary.zip",
            name: "binary.zip",
            mimeType: "application/zip",
            bytes: 1024,
          },
        ],
        {
          ...capabilities(provider),
          documents: [],
          embeddedContext: false,
        },
      );
      expect(result.input).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('Read the full file at "/repo/report.pdf"'),
        }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"binary.zip" (application/zip, 1024 bytes) sent as file'),
        }),
      ]);
      expect(result.diagnostics).toEqual([]);
    },
  );
  test("native aggregate limits fall back to the full file", () => {
    const result = projectAttachments([image, pdf], {
      ...capabilities("claude"),
      maxInlineBytes: 3,
    });
    expect(result.input[0]).toMatchObject({ type: "image" });
    expect(result.input[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(pdf.path),
    });
  });
  test("truncated text includes its name, language and full file path", () => {
    const result = projectAttachments(
      [{ ...text, bytes: 50000, truncated: true }],
      capabilities("codex"),
    );
    expect(result.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("language: ts"),
    });
    expect(JSON.stringify(result.input)).toContain("Inline text truncated");
    expect(JSON.stringify(result.input)).toContain(text.path);
  });
});

test("projection rejects noncanonical padding bits before producing provider media", () => {
  for (const provider of ["claude", "acp"] as const) {
    for (const base64 of ["AB==", "AAB="])
      expect(() => projectAttachments([{ ...image, base64 }], capabilities(provider))).toThrow();
    for (const base64 of ["AA==", "AAA="]) {
      const result = projectAttachments([{ ...image, base64 }], capabilities(provider));
      expect(result.input).toEqual(
        provider === "claude"
          ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }]
          : [{ type: "image", mimeType: "image/png", data: base64 }],
      );
    }
  }
});

test("OpenCode gives over-budget images a readable path", () => {
  const result = projectAttachments([image], { ...capabilities("opencode"), maxInlineBytes: 0 });
  expect(result.input).toEqual([{ type: "text", text: expect.stringContaining(image.path) }]);
  expect(result.diagnostics).toEqual([]);
});
