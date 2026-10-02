import { execFileSync } from "node:child_process";
import { z } from "zod";

// GitHub's disposable Ubuntu runners restrict unprivileged user namespaces.
// Enable them for this runner lifetime so Chromium's sandbox remains enabled.
// This entry point must never change a developer machine's kernel settings.
z.literal("true").parse(process.env.GITHUB_ACTIONS);
if (process.platform === "linux") {
  execFileSync("sudo", ["sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"], {
    stdio: "inherit",
  });
}
