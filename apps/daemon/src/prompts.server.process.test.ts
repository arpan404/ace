import { realpath, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PromptFiles } from "@ace/commands";
import { fixture } from "./socket-test-support.ts";

test("authenticated prompt edits persist over a real socket and stale revisions are refused", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-prompts-socket-")));
  let sequence = 0;
  const files = new PromptFiles({
    globalRoot: home,
    projectRoot: () => undefined,
    id: () => String(++sequence),
  });
  const f = await fixture({ promptFiles: files });
  try {
    const before = await f.open();
    before.send({
      type: "prompts.request",
      requestId: "unauthorized-write",
      operation: {
        op: "write",
        scope: { kind: "global" },
        name: "review.md",
        text: "Denied",
        expectedRevision: null,
      },
    });
    expect(await before.next()).toMatchObject({ type: "error", code: "unauthorized" });
    const client = await f.connect();
    await client.next();
    client.send({
      type: "prompts.request",
      requestId: "create",
      operation: {
        op: "write",
        scope: { kind: "global" },
        name: "review.md",
        text: "Review this branch.",
        expectedRevision: null,
      },
    });
    const saved = await client.next();
    expect(saved).toMatchObject({
      type: "prompts.result",
      requestId: "create",
      result: { kind: "file", file: { title: "review", diagnostics: [] } },
    });
    client.send({
      type: "prompts.request",
      requestId: "stale",
      operation: {
        op: "write",
        scope: { kind: "global" },
        name: "review.md",
        text: "Overwrite",
        expectedRevision: null,
      },
    });
    expect(await client.next()).toMatchObject({
      type: "prompts.result",
      result: { kind: "error", code: "conflict" },
    });
    expect(await readFile(join(home, "prompts/review.md"), "utf8")).toBe("Review this branch.");
    await client.close();
    const next = await f.connect();
    await next.next();
    next.send({
      type: "prompts.request",
      requestId: "reopen",
      operation: { op: "read", scope: { kind: "global" }, name: "review.md" },
    });
    expect(await next.next()).toMatchObject({
      type: "prompts.result",
      requestId: "reopen",
      result: { kind: "file", text: "Review this branch." },
    });
  } finally {
    await f.close();
    files.close();
    await rm(home, { recursive: true, force: true });
  }
});
