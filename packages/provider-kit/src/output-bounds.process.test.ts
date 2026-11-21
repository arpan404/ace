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
  // Each dropped line is 65 bytes with its newline, so at most three fit in the budget.
  expect(dropped.length).toBeGreaterThan(0);
  expect(dropped.length).toBeLessThanOrEqual(3);
});
