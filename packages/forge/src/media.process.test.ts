import { expect, test } from "vitest";
import { ForgeError } from "./errors.ts";
import { mediaKey } from "./github-media.ts";
import { fakeGh } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const asset = "98705180-e07b-4a5d-b44e-2941ed073508";
const video = "5ad13772-a0d3-4738-9e2e-6c15ca011ba1";
const jwt = (exp: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
const signed = (id: string, ext: string, exp: number) =>
  `https://private-user-images.githubusercontent.com/1/2-${id}.${ext}?jwt=${jwt(exp)}`;
const camo = "https://camo.githubusercontent.com/abc/687474703a2f2f";

// The shape GitHub's markdown endpoint answers with, one block per marker.
const rendered = [
  `<p dir="auto">ACEMEDIA0X</p>`,
  `<a target="_blank" href="${signed(asset, "png", 1_792_703_429)}"><img src="${signed(asset, "png", 1_792_703_429)}" style="max-width: 100%;"></a>`,
  `<p dir="auto">ACEMEDIA1X</p>`,
  `<p dir="auto"><a href="${camo}"><img src="${camo}" data-canonical-src="http://i.imgur.com/a.png"></a></p>`,
  `<p dir="auto">ACEMEDIA2X</p>`,
  `<details open=""><summary><span>flicker.mov</span></summary><video src="${signed(video, "mov", 1_792_703_459)}" controls="controls"></video></details>`,
  `<p dir="auto">ACEMEDIA3X</p>`,
  `<p dir="auto"><a href="https://example.com/notes">https://example.com/notes</a></p>`,
  `<p dir="auto">ACEMEDIA4X</p>`,
].join("\n");

test("each URL maps to the media GitHub rendered for it, and only the URLs are sent", async () => {
  const f = await fakeGh({ markdown: [{ raw: rendered }] });
  try {
    const items = [
      { url: `https://github.com/user-attachments/assets/${asset}`, role: "image" as const },
      { url: "http://i.imgur.com/a.png", role: "image" as const },
      { url: `https://github.com/user-attachments/assets/${video}`, role: "link" as const },
      { url: "https://example.com/notes", role: "link" as const },
      { url: "https://example.com/gone.png", role: "image" as const },
    ];
    expect(await f.forge.renderMedia(items, signal())).toEqual([
      { kind: "image", url: signed(asset, "png", 1_792_703_429), expiresAt: 1_792_703_429_000 },
      { kind: "image", url: camo, expiresAt: undefined },
      { kind: "video", url: signed(video, "mov", 1_792_703_459), expiresAt: 1_792_703_459_000 },
      null,
      null,
    ]);
    const [request] = await f.requests();
    expect(request?.args).toEqual(expect.arrayContaining(["markdown", "--method", "POST"]));
    expect(request?.body).toEqual({
      mode: "gfm",
      context: "octo/ace",
      text: [
        "ACEMEDIA0X",
        `<img src="https://github.com/user-attachments/assets/${asset}">`,
        "ACEMEDIA1X",
        '<img src="http://i.imgur.com/a.png">',
        "ACEMEDIA2X",
        `https://github.com/user-attachments/assets/${video}`,
        "ACEMEDIA3X",
        "https://example.com/notes",
        "ACEMEDIA4X",
        '<img src="https://example.com/gone.png">',
      ].join("\n\n"),
    });
  } finally {
    await f.cleanup();
  }
});

const kind = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof ForgeError ? error.kind : "other"),
  );

test("a render GitHub refuses or rate-limits fails with its fixed category", async () => {
  const f = await fakeGh({
    markdown: [
      { status: 403, raw: '{"message":"Resource not accessible"}' },
      { status: 403, raw: '{"message":"API rate limit exceeded"}' },
      { offline: true },
    ],
  });
  const items = [{ url: "https://example.com/a.png", role: "image" as const }];
  try {
    expect(await kind(f.forge.renderMedia(items, signal()))).toBe("forbidden");
    expect(await kind(f.forge.renderMedia(items, signal()))).toBe("rate_limit");
    expect(await kind(f.forge.renderMedia(items, signal()))).toBe("offline");
  } finally {
    await f.cleanup();
  }
});

test("an attachment keeps one key whether written as its upload URL or a pasted signed URL", () => {
  const upload = mediaKey(`https://github.com/user-attachments/assets/${asset.toUpperCase()}`);
  expect(upload).toBe(`asset:${asset}`);
  expect(mediaKey(signed(asset, "png", 1))).toBe(upload);
  expect(mediaKey("https://example.com/a.png#top")).toBe("url:https://example.com/a.png");
  expect(mediaKey("javascript:alert(1)")).toBeUndefined();
  expect(mediaKey("docs/screenshot.png")).toBeUndefined();
});
