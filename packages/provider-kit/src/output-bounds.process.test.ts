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
