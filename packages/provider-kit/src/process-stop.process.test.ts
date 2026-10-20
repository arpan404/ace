import { expect, test } from "vitest";
import { spawnRawSupervised, stopOwnedGroups } from "./process.ts";

const stubborn = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"];

for (const retained of [false, true])
  test(`a forced stop overtakes a polite stop's long grace${retained ? " for a retained group" : ""}`, async () => {
    const child = spawnRawSupervised({
      command: process.execPath,
      args: stubborn,
      env: process.env,
      name: "stubborn",
      ...(retained ? { killGroupOnExit: false } : {}),
    });
    // Let the child install its SIGTERM handler before anything signals it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const polite = child.stop({ graceMs: 60_000 });
    const began = performance.now();
    await stopOwnedGroups(100);
    await polite;
    expect(performance.now() - began).toBeLessThan(5_000);
    expect((await child.exited).signal).toBe("SIGKILL");
  });

test("a later, longer stop never delays the SIGKILL an earlier stop scheduled", async () => {
  const child = spawnRawSupervised({
    command: process.execPath,
    args: stubborn,
    env: process.env,
    name: "stubborn",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const began = performance.now();
  void child.stop({ graceMs: 100 });
  await child.stop({ graceMs: 60_000 });
  expect(performance.now() - began).toBeLessThan(5_000);
});
