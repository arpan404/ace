import { once } from "node:events";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { spawnSdkProcess } from "./sdk-process.ts";

// Claude passes its MCP servers' stderr through, so a chatty server's log line reaches this pipe.
const child = `
process.stderr.write(("x".repeat(8192) + "\\n").repeat(50) + "still here\\n", () =>
  process.stdout.write(JSON.stringify({ type: "keep_alive" }) + "\\n"),
);
process.stdin.resume();
`;

it("Claude survives a flood of oversized stderr lines, noted once as they arrive", async () => {
  const controller = new AbortController();
  const stderr: string[] = [];
  let proc: SupervisedProcess | undefined;
  const spawned = spawnSdkProcess(
    { command: process.execPath, args: ["-e", child], env: {}, signal: controller.signal },
    {
      onStderr: (line) => void stderr.push(line),
      onWire: () => {},
      onProcess: (value) => {
        proc = value;
      },
      // A small line limit stands in for the 16 MiB default.
      spawn: (options) => spawnSupervised({ ...options, maxLineBytes: 4096 }),
    },
  );
  const exited = new Promise((resolve) => spawned.on("exit", resolve));
  try {
    const [line] = await once(createInterface({ input: spawned.stdout }), "line");
    expect(JSON.parse(String(line))).toEqual({ type: "keep_alive" });
    await expect.poll(() => stderr).toContain("still here");
    expect(stderr).toEqual(["ace dropped a stderr line of 8192 bytes", "still here"]);
    expect(proc?.signal.aborted).toBe(false);
  } finally {
    controller.abort();
    await exited;
  }
  // The rest of the flood is summed into one note, flushed when Claude exits.
  expect(stderr.slice(2)).toEqual(["ace dropped 49 stderr lines, 401408 bytes in total"]);
});
