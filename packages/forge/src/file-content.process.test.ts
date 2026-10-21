import { expect, test } from "vitest";
import { fakeGh, sha, nextSha } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const blobSha = "c".repeat(40);
const contents = (path: string, ref = sha) => `repos/octo/ace/contents/${path}?ref=${ref}`;
const inline = (bytes: Buffer) => ({
  body: {
    type: "file",
    size: bytes.length,
    sha: blobSha,
    encoding: "base64",
    content: bytes.toString("base64"),
  },
});

test("a large text file reads in pages from its blob, and a second read asks GitHub nothing", async () => {
  const text = `${"a".repeat(200_000)}\n${"b".repeat(100_000)}\n`;
  const f = await fakeGh({
    [contents("yarn.lock")]: [
      { body: { type: "file", size: text.length, sha: blobSha, encoding: "none", content: "" } },
    ],
    [`repos/octo/ace/git/blobs/${blobSha}`]: [
      {
        body: {
          sha: blobSha,
          size: text.length,
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
        },
      },
    ],
  });
  try {
    const first = await f.forge.fileContent({ sha, path: "yarn.lock", page: 1 }, signal());
    expect(first).toMatchObject({ kind: "text", size: text.length, nextPage: 2 });
    const second = await f.forge.fileContent({ sha, path: "yarn.lock", page: 2 }, signal());
    expect(second).toMatchObject({ kind: "text", size: text.length });
    expect(second).not.toHaveProperty("nextPage");
    expect(first.kind === "text" && second.kind === "text" && first.text + second.text).toBe(text);
    expect((await f.requests()).map((request) => request.path)).toEqual([
      contents("yarn.lock"),
      `repos/octo/ace/git/blobs/${blobSha}`,
    ]);
  } finally {
    await f.cleanup();
  }
});

test("an image comes back as bytes, other binaries and oversized files only by size", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
  const f = await fakeGh({
    [contents("assets/logo.png")]: [inline(png)],
    [contents("bin/tool")]: [inline(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]))],
    [contents("data/huge.json")]: [
      { body: { type: "file", size: 9_000_000, sha: blobSha, encoding: "none", content: "" } },
    ],
  });
  try {
    const image = { sha, path: "assets/logo.png", page: 1, image: "image/png" as const };
    expect(await f.forge.fileContent(image, signal())).toEqual({
      kind: "image",
      type: "image/png",
      data: png.toString("base64"),
      size: png.length,
    });
    // The same bytes asked for as text are binary, read from what was kept.
    expect(await f.forge.fileContent({ ...image, image: undefined }, signal())).toEqual({
      kind: "binary",
      size: png.length,
    });
    expect((await f.requests()).filter((request) => request.path.includes("logo"))).toHaveLength(1);
    expect(await f.forge.fileContent({ sha, path: "bin/tool", page: 1 }, signal())).toEqual({
      kind: "binary",
      size: 7,
    });
    expect(await f.forge.fileContent({ sha, path: "data/huge.json", page: 1 }, signal())).toEqual({
      kind: "large",
      size: 9_000_000,
    });
    // The oversized file's bytes are never asked for.
    expect((await f.requests()).some((request) => request.path.includes("git/blobs"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a side the commit doesn't have reads as missing, and a path can't leave the repository", async () => {
  const f = await fakeGh({
    [contents("src/new.ts", nextSha)]: [{ status: 404, body: { message: "Not Found" } }],
    [contents("src")]: [{ body: [{ type: "file", name: "a.ts" }] }],
  });
  try {
    expect(
      await f.forge.fileContent({ sha: nextSha, path: "src/new.ts", page: 1 }, signal()),
    ).toEqual({ kind: "missing" });
    expect(await f.forge.fileContent({ sha, path: "src", page: 1 }, signal())).toEqual({
      kind: "missing",
    });
    await expect(
      f.forge.fileContent({ sha, path: "../../user", page: 1 }, signal()),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  } finally {
    await f.cleanup();
  }
});

test("text content is scrubbed of recognised secrets like every other hosted text", async () => {
  const f = await fakeGh({
    [contents(".env.example")]: [inline(Buffer.from("TOKEN=ghp_abcdefghijklmnop\nmode=dev\n"))],
  });
  try {
    const read = await f.forge.fileContent({ sha, path: ".env.example", page: 1 }, signal());
    expect(read.kind === "text" && read.text).not.toContain("ghp_abcdefghijklmnop");
    expect(read.kind === "text" && read.text).toContain("mode=dev");
  } finally {
    await f.cleanup();
  }
});
