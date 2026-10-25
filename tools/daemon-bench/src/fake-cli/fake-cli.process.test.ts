import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { installFakeCli, recordings } from "./install.ts";

const run = promisify(execFile);
let directory = "";
let claude = "";
const env = { ...process.env, ACE_FAKE_CLI_FIXTURES: recordings.claude, ACE_FAKE_CLI_SPEED: "0" };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-fake-cli-"));
  claude = await installFakeCli(join(directory, "bin"), "claude");
});
afterAll(() => rm(directory, { recursive: true, force: true }));

const Frame = z.looseObject({ type: z.string() });
async function session(lines: unknown[]) {
  const child = spawn(claude, ["--input-format", "stream-json", "--session-id", "session-1"], {
    env,
    cwd: directory,
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stdin.end(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const code = await new Promise((resolve) => child.once("close", resolve));
  expect(code).toBe(0);
  return stdout
    .trim()
    .split("\n")
    .map((line) => Frame.parse(JSON.parse(line)));
}
const user = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "text", text }] },
});

test("probes report the recorded CLI version and a signed-in account", async () => {
  expect((await run(claude, ["--version"], { env })).stdout).toBe("2.1.286 (Claude Code)\n");
  const auth = JSON.parse((await run(claude, ["auth", "status"], { env })).stdout);
  expect(auth).toMatchObject({ loggedIn: true });
});

test("each turn ends with a result that echoes its user message and counts turns", async () => {
  const frames = await session([user("first", "one"), user("second", "two")]);
  const results = frames.filter((frame) => frame.type === "result");
  expect(results.map((frame) => [frame["user_message_uuid"], frame["result_index"]])).toEqual([
    ["first", 1],
    ["second", 2],
  ]);
  expect(new Set(frames.map((frame) => frame["session_id"]).filter(Boolean))).toEqual(
    new Set(["session-1"]),
  );
  // Provider ids repeat in the recording; the replay must not reuse them across turns.
  const toolIds = frames
    .map((frame) => JSON.stringify(frame).match(/"(toolu_[A-Za-z0-9]+)"/)?.[1])
    .filter(Boolean);
  expect(new Set(toolIds).size).toBe(2);
  const uuids = frames.map((frame) => frame["uuid"]).filter(Boolean);
  expect(new Set(uuids).size).toBe(uuids.length);
  expect(JSON.stringify(frames)).not.toContain("<WORKSPACE>");
});

test("control requests are answered with success for the same request id", async () => {
  const frames = await session([
    { type: "control_request", request_id: "init-1", request: { subtype: "initialize" } },
    { type: "control_request", request_id: "mode-1", request: { subtype: "set_permission_mode" } },
  ]);
  expect(frames.map((frame) => frame["response"])).toMatchObject([
    { subtype: "success", request_id: "init-1" },
    { subtype: "success", request_id: "mode-1" },
  ]);
});

test("a text-deltas directive streams a long answer whose final text matches the deltas", async () => {
  const frames = await session([user("long", "write it all text-deltas=50")]);
  const Delta = z.object({
    event: z.object({
      type: z.literal("content_block_delta"),
      index: z.number(),
      delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
    }),
  });
  const deltas = frames.flatMap((frame) => {
    const parsed = Delta.safeParse(frame);
    return parsed.success ? [parsed.data.event.delta.text] : [];
  });
  expect(deltas.length).toBeGreaterThan(50);
  const Assistant = z.object({
    message: z.object({
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
    }),
  });
  const finalText = frames
    .filter((frame) => frame.type === "assistant")
    .flatMap((frame) => Assistant.parse(frame).message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  expect(finalText).toBe(deltas.join(""));
  expect(frames.at(-1)).toMatchObject({ type: "result", user_message_uuid: "long" });
});
