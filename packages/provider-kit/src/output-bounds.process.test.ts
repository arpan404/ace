import { expect, onTestFinished, test } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";

test.each([
  { name: "line", maxLineBytes: 8, maxOutputBytes: 1024, output: "x".repeat(64) },
  { name: "total", maxLineBytes: 64, maxOutputBytes: 8, output: "x\n".repeat(32) },
])(
  "the $name byte limit still stops an owned process when both limits are configured",
  async ({ maxLineBytes, maxOutputBytes, output }) => {
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);`],
      env: {},
      name: "both-output-limits",
      maxLineBytes,
      maxOutputBytes,
    });
    onTestFinished(async () => {
      await child.stop({ graceMs: 0 });
    });
    try {
      expect((await child.exited).reason).toBe("output-limit");
    } finally {
      await child.stop({ graceMs: 0 });
    }
  },
);

test.each(["stderr", "total"])(
  "opting into stdout drops still kills on the %s limit",
  async (kind) => {
    const child = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        kind === "stderr"
          ? 'process.stderr.write("x".repeat(64)); setInterval(() => {}, 1000);'
          : 'process.stdout.write("x".repeat(64) + "\\n"); setInterval(() => {}, 1000);',
      ],
      env: {},
      name: "stdout-drop-other-budget",
      maxLineBytes: 8,
      ...(kind === "total" ? { maxOutputBytes: 16 } : {}),
      onStdoutLineDropped() {
        throw new Error("No stdout drop should bypass this budget");
      },
    });
    onTestFinished(async () => {
      await child.stop({ graceMs: 0 });
    });
    expect(await child.exited).toMatchObject({ reason: "output-limit", signal: "SIGKILL" });
  },
);

test("opting into stderr drops keeps the process and its later stderr lines", async () => {
  const dropped: number[] = [];
  const lines: string[] = [];
  const child = spawnSupervised({
    command: process.execPath,
    args: [
      "-e",
      'process.stderr.write("x".repeat(64) + "\\nafter\\n"); process.stdout.write("ok\\n");',
    ],
    env: {},
    name: "stderr-drop",
    maxLineBytes: 8,
    onStderrLineDropped(line) {
      if (line.phase !== "start") dropped.push(line.bytes);
    },
  });
  child.stderr.on("line", (line: string) => lines.push(line));
  onTestFinished(async () => {
    await child.stop({ graceMs: 0 });
  });
  expect(await child.exited).toMatchObject({ reason: "exit", code: 0 });
  expect(dropped).toEqual([64]);
  expect(lines).toEqual(["after"]);
});

test("dropped stderr lines still count toward the total output budget", async () => {
  const dropped: number[] = [];
  const child = spawnSupervised({
    command: process.execPath,
    args: [
      "-e",
      'for (let i = 0; i < 8; i++) process.stderr.write("x".repeat(64) + "\\n"); setInterval(() => {}, 1000);',
    ],
    env: {},
    name: "stderr-drop-total",
    maxLineBytes: 8,
    maxOutputBytes: 256,
    onStderrLineDropped(line) {
      dropped.push(line.bytes);
    },
  });
  onTestFinished(async () => {
    await child.stop({ graceMs: 0 });
  });
  expect(await child.exited).toMatchObject({ reason: "output-limit", signal: "SIGKILL" });
  // The child never exits on its own, so only the total budget can end it. Each dropped line
  // is 65 bytes with its newline, so at most three fit; a single chunk may trip it before any.
  expect(dropped.length).toBeLessThanOrEqual(3);
});

test("dropped stderr lines wait while the output flow is paused", async () => {
  const dropped: number[] = [];
  let paused = true;
  const released = Promise.withResolvers<void>();
  const child = spawnSupervised({
    command: process.execPath,
    args: [
      "-e",
      // One oversized line per chunk.
      `let n = 0;
const next = () => {
  if (n++ < 20) process.stderr.write("x".repeat(64) + "\\n", () => setTimeout(next, 5));
};
next();`,
    ],
    env: {},
    name: "stderr-drop-flow",
    maxLineBytes: 8,
    outputFlow: { paused: () => paused, wait: () => released.promise },
    onStderrLineDropped(line) {
      if (line.phase !== "start") dropped.push(line.bytes);
    },
  });
  onTestFinished(async () => {
    await child.stop({ graceMs: 0 });
  });
  // The child writes every line well within this; a reader that ignores the pause hears them all.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(dropped.length).toBeLessThanOrEqual(1);
  paused = false;
  released.resolve();
  expect(await child.exited).toMatchObject({ reason: "exit", code: 0 });
  expect(dropped).toHaveLength(20);
});
