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
  test("Claude receives image and PDF sources while selected mention text remains verbatim", () => {
    const result = projectAttachments([text, image, pdf], capabilities("claude"));
    expect(result.input).toEqual([
      { type: "text", text: text.text },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "YWJj" },
        title: "report.pdf",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  test("Codex receives a daemon-local image path and a diagnostic for unsupported PDFs", () => {
    const result = projectAttachments([text, image, pdf], capabilities("codex"));
    expect(result.input).toEqual([
      { type: "text", text: text.text, text_elements: [] },
      { type: "localImage", path: image.path, mimeType: "image/png" },
      {
        type: "text",
        text: `Provider ${result.provider} cannot take attachment "report.pdf" (application/pdf) within its media capabilities and size limits.`,
        text_elements: [],
      },
    ]);
    expect(result.diagnostics[0]).toMatchObject({ code: "unsupported" });
  });
  test("OpenCode receives file parts with MIME and escaped local URLs", () => {
    const result = projectAttachments([text, image, pdf], capabilities("opencode"));
    expect(result.input).toEqual([
      { type: "text", text: text.text },
      {
        type: "file",
        mime: "image/png",
        filename: image.name,
        url: "data:image/png;base64,YWJj",
      },
      {
        type: "file",
        mime: "application/pdf",
        filename: pdf.name,
        url: "file:///repo/report.pdf",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  test("ACP receives embedded resources and base64 images when negotiated", () => {
    const result = projectAttachments([text, image, pdf], capabilities("acp"));
    expect(result.input).toEqual([
      {
        type: "resource",
        resource: { uri: "file:///repo/main.ts", mimeType: "text/plain", text: text.text },
      },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      {
        type: "resource",
        resource: { uri: "file:///repo/report.pdf", mimeType: "application/pdf", blob: "YWJj" },
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  test("ACP retains context as text and diagnoses media when capabilities are absent", () => {
    const result = projectAttachments([text, image, pdf], {
      ...capabilities("acp"),
      embeddedContext: false,
      images: [],
    });
    expect(result.input).toEqual([
      { type: "text", text: text.text },
      {
        type: "text",
        text: `Provider acp cannot take attachment "image one.png" (image/png) within its media capabilities and size limits.`,
      },
      {
        type: "text",
        text: `Provider ${result.provider} cannot take attachment "report.pdf" (application/pdf) within its media capabilities and size limits.`,
      },
    ]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["unsupported", "unsupported"]);
  });
  test("aggregate inline budgets fall back before exceeding the provider limit", () => {
    const result = projectAttachments([image, pdf], {
      ...capabilities("claude"),
      maxInlineBytes: 3,
    });
    expect(result.input[0]).toMatchObject({ type: "image" });
    expect(result.input[1]).toEqual({
      type: "text",
      text: `Provider ${result.provider} cannot take attachment "report.pdf" (application/pdf) within its media capabilities and size limits.`,
    });
    expect(result.diagnostics).toHaveLength(1);
  });
  test("missing bytes and unsupported MIME types explain provider limitations without local paths", () => {
    const result = projectAttachments(
      [
        { path: "/repo/x.svg", name: "x.svg", mimeType: "image/svg+xml" },
        { ...image, base64: undefined },
      ],
      capabilities("claude"),
    );
    expect(result.input.every((part) => part.type === "text")).toBe(true);
    expect(result.diagnostics).toHaveLength(2);
  });
});

test("Claude plaintext uploads become native document blocks when supported", () => {
  const result = projectAttachments(
    [{ path: "/repo/readme.txt", name: "readme.txt", mimeType: "text/plain", base64: "aGVsbG8=" }],
    { ...capabilities("claude"), documents: ["text/plain"] },
  );
  expect(result.input).toEqual([
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "hello" },
      title: "readme.txt",
    },
  ]);
  expect(result.diagnostics).toEqual([]);
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

test("OpenCode diagnoses an image above its inline budget without sending an opaque path", () => {
  const result = projectAttachments([image], { ...capabilities("opencode"), maxInlineBytes: 0 });
  expect(result.input).toEqual([
    {
      type: "text",
      text: 'Provider opencode cannot take attachment "image one.png" (image/png) within its media capabilities and size limits.',
    },
  ]);
  expect(result.diagnostics).toMatchObject([{ code: "unsupported" }]);
  expect(JSON.stringify(result)).not.toContain("/repo/");
});
