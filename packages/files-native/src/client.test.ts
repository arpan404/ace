import { afterEach, describe, expect, it } from "vitest";
import { FilesClient } from "./client.ts";
import type { FileMatches, SearchQuery } from "./schemas.ts";
import {
  fakeBodies,
  fakeFilesHarness,
  fakeMessages,
  stopFakeFiles,
  until,
  type FakeFilesHarness,
} from "./test-support.ts";

const open: FakeFilesHarness[] = [];

function harness(): { h: FakeFilesHarness; client: FilesClient } {
  const h = fakeFilesHarness();
  open.push(h);
  return { h, client: new FilesClient(h.files) };
}

afterEach(async () => {
  for (const h of open.splice(0)) await stopFakeFiles(h);
});

const query: SearchQuery = {
  pattern: "cache",
  regex: false,
  case: "smart",
  wholeWord: true,
  include: [],
  exclude: [],
  includeIgnored: false,
  maxMatches: 10,
  maxFileBytes: 1024,
};

describe("FilesClient", () => {
  it("lists a folder with the plan's default page size and hide list", async () => {
    const { h, client } = harness();
    await client.start();
    const root = await client.openRoot("/repo");
    const page = await client.list(root, "");
    expect(page.entries.map((entry) => entry.name)).toEqual(["main.ts"]);
    const list = fakeMessages(h).find(
      (message) => message.type === "request" && message.op.op === "list",
    );
    expect(list).toMatchObject({ op: { limit: 500, hide: [".git", ".DS_Store"] } });
  });

  it("reads a file's bytes from its body frame", async () => {
    const { client } = harness();
    await client.start();
    const root = await client.openRoot("/repo");
    const { meta, bytes } = await client.read(root, "README.md", { length: 16 });
    expect(meta).toMatchObject({ type: "read", body: true, encoding: "UTF-8" });
    expect(new TextDecoder().decode(bytes)).toBe("read:README.md");
  });

  it("writes bytes in a body frame and returns the new version", async () => {
    const { h, client } = harness();
    await client.start();
    const root = await client.openRoot("/repo");
    const result = await client.write(root, "README.md", new TextEncoder().encode("hello"), {
      expected: "0:0:0:0:0",
    });
    expect(result.version).toBe("0:0:0:1:1");
    const write = fakeMessages(h).find(
      (message) => message.type === "request" && message.op.op === "write",
    );
    expect(write).toMatchObject({ op: { expected: "0:0:0:0:0" } });
    await until(() => fakeBodies(h).some((body) => body.bytes === 5));
  });

  it("streams search matches and resolves with the summary", async () => {
    const { client } = harness();
    await client.start();
    const root = await client.openRoot("/repo");
    const matches: FileMatches[] = [];
    const summary = await client.search(root, query, {
      onMatches: (file) => matches.push(file),
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("src/main.ts");
    expect(summary).toMatchObject({ files: 1, matches: 1, limitHit: false });
  });

  it("disposing a watch sends unwatch", async () => {
    const { h, client } = harness();
    await client.start();
    const root = await client.openRoot("/repo");
    const watch = await client.watch(root, () => {});
    await watch.dispose();
    await until(() =>
      fakeMessages(h).some((message) => message.type === "request" && message.op.op === "unwatch"),
    );
  });
});
