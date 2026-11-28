import { expect, test } from "vitest";
import { codexCompactCommand } from "./compaction.ts";

test("compaction starts Codex's own thread compaction on the app-server", async () => {
  const sent: [string, unknown][] = [];
  const commands = codexCompactCommand(
    async (method, params) => {
      sent.push([method, params]);
      return {};
    },
    "native",
    () => {},
  );
  await commands.compact();
  expect(sent).toEqual([["thread/compact/start", { threadId: "native" }]]);
});

test("a closed Codex session refuses compaction before it reaches the wire", async () => {
  const sent: [string, unknown][] = [];
  const commands = codexCompactCommand(
    async (method, params) => {
      sent.push([method, params]);
      return {};
    },
    "native",
    () => {
      throw new Error("Codex session is closed");
    },
  );
  await expect(commands.compact()).rejects.toThrow("Codex session is closed");
  expect(sent).toEqual([]);
});
