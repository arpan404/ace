import { execFileSync, spawnSync } from "node:child_process";
import { lockedExitCode } from "./session-exit.ts";
import { loadavg } from "node:os";
import { z } from "zod";

// CI without Xcode/simulator support must not download or boot anything, and
// ACE_PERF_DEVICE=0 keeps a machine's Simulators untouched while device work is paused.
if (process.env["ACE_PERF_DEVICE"] === "0") {
  console.log("device perf: skipped, ACE_PERF_DEVICE=0");
} else if (process.platform !== "darwin") {
  console.log("device perf: skipped, iOS Simulator requires macOS");
} else {
  let runtime: string | undefined;
  try {
    const output = execFileSync("xcrun", ["simctl", "list", "runtimes", "-j"], {
      encoding: "utf8",
      timeout: 15000,
    });
    const inventory = z
      .object({ runtimes: z.array(z.object({ identifier: z.string(), isAvailable: z.boolean() })) })
      .parse(JSON.parse(output));
    runtime = inventory.runtimes.find(
      (r) => r.isAvailable && r.identifier.includes(".iOS-"),
    )?.identifier;
  } catch {
    /* no usable Xcode */
  }
  if (!runtime) console.log("device perf: skipped, no available iOS Simulator runtime");
  else {
    const session = spawnSync(
      process.execPath,
      [new URL("./session.ts", import.meta.url).pathname],
      { stdio: "inherit", timeout: 10000 },
    );
    if (session.status === lockedExitCode)
      console.log("device perf: skipped, desktop is locked; rerun unlocked to qualify human input");
    else if (session.status !== 0)
      throw new Error(
        `device perf: session precondition failed (${session.status ?? session.signal})`,
      );
    else if ((loadavg()[0] ?? Infinity) >= 15)
      console.log("device perf: skipped, host load >= 15; rerun on an idle host");
    else
      execFileSync("sh", [new URL("./run.sh", import.meta.url).pathname], {
        stdio: "inherit",
        env: {
          ...process.env,
          ACE_PERF_RUNTIME: runtime,
          ACE_PERF_DRIVER: "electron",
          ACE_PERF_ASSERT: "1",
          ACE_PERF_REBUILD: "1",
          ACE_PERF_PACKAGED: "1",
        },
        timeout: 300000,
      });
  }
}
