import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { z } from "zod";
import { rgSearch } from "./rg-search.ts";
import { workspaceRuntime } from "./runtime.ts";

const require = createRequire(import.meta.url);
const binary = z.object({ rgPath: z.string() }).parse(require("@vscode/ripgrep")).rgPath;

async function* bytes(text: string): AsyncGenerator<Buffer> {
  const buffer = Buffer.from(text);
  for (let offset = 0; offset < buffer.length; offset += 2)
    yield buffer.subarray(offset, offset + 2);
}

function request(files: { path: string; input: AsyncIterable<Buffer> }[]) {
  return {
    files,
    query: "needle",
    regex: false,
    caseSensitive: true,
    limit: 20,
    bytes: 4096,
  };
}

// The real Windows transport can also run on POSIX: it uses only standard
// stdin, so these fixtures exercise the same path on every development host.
const runtime = { ...workspaceRuntime(), platform: "win32" as const };

test("stdin search returns logical paths and UTF-8 columns without opening those paths", async () => {
  const result = await rgSearch(
    runtime,
    binary,
    request([
      { path: "absent/café-日本語.txt", input: bytes("π needle\nnot here\n") },
      { path: "also-absent/second.txt", input: bytes("blank\nneedle!\n") },
    ]),
  );
  expect(result).toEqual([
    { path: "absent/café-日本語.txt", line: 1, column: 4, preview: "π needle" },
    { path: "also-absent/second.txt", line: 2, column: 1, preview: "needle!" },
  ]);
});

const files = () => [{ path: "absent.txt", input: bytes("NEEDLE\nneedle\nn.e[d]le\n") }];

test("stdin search preserves case and fixed versus regex matching", async () => {
  const insensitive = await rgSearch(runtime, binary, {
    ...request(files()),
    caseSensitive: false,
  });
  expect(insensitive.map((match) => match.line)).toEqual([1, 2]);
  const fixed = await rgSearch(runtime, binary, { ...request(files()), query: "n.e[d]le" });
  expect(fixed.map((match) => match.line)).toEqual([3]);
  const regex = await rgSearch(runtime, binary, {
    ...request(files()),
    query: "n.e[d]le",
    regex: true,
  });
  expect(regex.map((match) => match.line)).toEqual([2]);
});

async function* unread(): AsyncGenerator<Buffer> {
  yield await Promise.reject(new Error("Input must not be consumed"));
}

test("stdin search stops at the global match limit before reading another file", async () => {
  const matches = await rgSearch(runtime, binary, {
    ...request([
      { path: "first.txt", input: bytes("needle\nneedle\nneedle\n") },
      { path: "second.txt", input: unread() },
    ]),
    limit: 2,
  });
  expect(matches).toEqual([
    { path: "first.txt", line: 1, column: 1, preview: "needle" },
    { path: "first.txt", line: 2, column: 1, preview: "needle" },
  ]);
});

test("stdin search rejects an already cancelled request before consuming input", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    rgSearch(
      runtime,
      binary,
      request([{ path: "unread.txt", input: unread() }]),
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "ABORTED" });
});
