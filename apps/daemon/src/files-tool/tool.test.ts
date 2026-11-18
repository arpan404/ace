import { expect, it } from "vitest";
import { FilesTool } from "./tool.ts";

it("fails folder features retryably when this machine has no ace-files", async () => {
  const tool = new FilesTool({ binary: undefined });
  expect(tool.available).toBe(false);
  await expect(tool.client()).rejects.toMatchObject({
    code: "FILES_RESTARTING",
    retryable: true,
  });
  await expect(tool.listFolder("/w", "")).rejects.toMatchObject({
    code: "FILES_RESTARTING",
    retryable: true,
  });
  expect(await tool.quickOpen("/w", "main", 20)).toBeUndefined();
  await tool.close();
});

it("names a folder ace-files cannot open as not found", async () => {
  const tool = new FilesTool({ binary: undefined });
  await expect(tool.canonical("/definitely/not/here/at/all")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await tool.close();
});

it("does nothing to watch on a machine with no ace-files", async () => {
  const tool = new FilesTool({ binary: undefined });
  await expect(tool.watch("/definitely/not/here/at/all", () => {})).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await tool.sweep()).toEqual([]);
  await tool.close();
});
