import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId, type ContentPart } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession } from "./index.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { object, list } from "./data.ts";
test("several mid-message ACP commands each reach the harness with a native prefix and complete context", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-catalog-"));
  const frames: Frame[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("catalog"),
      cwd: home,
      signal: new AbortController().signal,
      onFrame: (f) => frames.push(f),
      onExit: () => {},
    },
    genericQuirks,
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url))],
      env: { HOME: home },
    },
  );
  const input: ContentPart[] = [
    { type: "text", text: "Please use " },
    {
      type: "mention",
      entryId: "one",
      kind: "command",
      name: "Search",
      arguments: "query",
      invocation: { type: "slash", name: "catalog-search" },
    },
    { type: "text", text: " then " },
    {
      type: "mention",
      entryId: "two",
      kind: "command",
      name: "Test",
      arguments: "",
      invocation: { type: "slash", name: "catalog-test" },
    },
    { type: "text", text: " here." },
  ];
  try {
    await session.send(input, "queue");
    const prompts = frames
      .filter((f) => f.dir === "send" && object(f.data).method === "session/prompt")
      .map((f) => list(object(object(f.data).params).prompt));
    expect(prompts.map((p) => object(p[0]).text)).toEqual([
      "/catalog-search query\n\nMessage context:\n",
      "/catalog-test\n\nMessage context:\n",
    ]);
    expect(
      prompts.map((p) =>
        p
          .slice(1)
          .map((v) => object(v).text)
          .join(""),
      ),
    ).toEqual(["Please use [Search] then [Test] here.", "Please use [Search] then [Test] here."]);
    expect(input[0]).toEqual({ type: "text", text: "Please use " });
  } finally {
    await session.close("shutdown");
    await rm(home, { recursive: true, force: true });
  }
});
