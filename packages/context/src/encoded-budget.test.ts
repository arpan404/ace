import { expect, test } from "vitest";
import { projectAttachments, encodedContextBudget } from "./index.ts";

test.each(["acp", "opencode"] as const)(
  "%s preserves a file fallback when prompt escaping consumes its inline budget",
  (provider) => {
    const base = [{ type: "text" as const, text: '"'.repeat(100_000) }];
    const image = {
      path: "/repo/large.png",
      name: "large.png",
      mimeType: "image/png",
      bytes: 600_000,
      base64: Buffer.alloc(600_000).toString("base64"),
    };
    const projection = projectAttachments([image], {
      provider,
      images: ["image/png"],
      documents: [],
      embeddedContext: true,
      maxInlineBytes: 4 * 1024 * 1024,
      maxEncodedBytes: encodedContextBudget(base),
    });
    expect(projection.input).toMatchObject([{ type: "text" }]);
    expect(JSON.stringify(projection.input)).toContain("/repo/large.png");
  },
);

test.each(["acp", "opencode"] as const)(
  "%s projects aggregate images within the complete encoded transport budget",
  (provider) => {
    const images = [0, 1].map((index) => ({
      path: `/repo/image-${index}.png`,
      name: `image-${index}.png`,
      mimeType: "image/png",
      bytes: 600_000,
      base64: Buffer.alloc(600_000, index).toString("base64"),
    }));
    const projection = projectAttachments(images, {
      provider,
      images: ["image/png"],
      documents: [],
      embeddedContext: true,
      maxInlineBytes: 4 * 1024 * 1024,
    });
    expect(Buffer.byteLength(JSON.stringify(projection.input))).toBeLessThan(
      1024 * 1024 - 64 * 1024,
    );
    expect(
      projection.input.some(
        (part) => part.type === "text" && part.text.includes("/repo/image-1.png"),
      ),
    ).toBe(true);
  },
);
