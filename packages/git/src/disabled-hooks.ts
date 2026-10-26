import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git for Windows can interpret /dev/null as C:\dev\null. A unique empty
// directory avoids consulting a predictable path another user could populate.
// This I/O shell owns the directory for the lifetime of this process.
let directory: string | undefined;
function configurationRoot(): string {
  if (directory === undefined) {
    const created = mkdtempSync(join(tmpdir(), "ace-git-hooks-"));
    mkdirSync(join(created, "hooks"), { mode: 0o700 });
    writeFileSync(join(created, "attributes"), "", { flag: "wx", mode: 0o600 });
    directory = created;
    process.once("exit", () => {
      try {
        // Never recursively delete an unexpected entry.
        rmdirSync(join(created, "hooks"));
        unlinkSync(join(created, "attributes"));
        rmdirSync(created);
      } catch {
        // Crash/exit cleanup is best effort; no checkout data lives here.
      }
    });
  }
  return directory;
}

export function disabledHooksPath(): string {
  return join(configurationRoot(), "hooks");
}

export function disabledAttributesPath(): string {
  return join(configurationRoot(), "attributes");
}

export function withoutHooks(): string[] {
  return ["-c", `core.hooksPath=${disabledHooksPath()}`];
}
