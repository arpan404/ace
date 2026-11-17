import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseData } from "@ace/protocol";
import { spadeMigrationCount } from "../src/packaging/release-data.ts";

/**
 * The data formats of the source tree at `root` (ADR 0174): `HOME_FORMAT_VERSION`, the daemon's
 * `schemaVersion`, notify's `FORMAT` and Spade's migration count. The three TypeScript constants
 * are imported from that tree in a child process, so the numbers are the ones its own code
 * computes, and a checkout of an older tag answers for itself instead of for this build. The
 * checkout needs its dependencies installed (`bun install`).
 */
export async function releaseDataAt(root: string): Promise<ReleaseData> {
  const program = `
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const root = process.argv[1];
    const load = (path) => import(pathToFileURL(join(root, path)).href);
    const [home, daemon, notify] = await Promise.all([
      load("packages/service/src/home-format.ts"),
      load("apps/daemon/src/migrations.ts"),
      load("packages/notify/src/format.ts"),
    ]);
    process.stdout.write(JSON.stringify({
      home: home.HOME_FORMAT_VERSION,
      daemon: daemon.schemaVersion,
      notify: notify.FORMAT,
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program, root], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const constants: unknown = JSON.parse(output);
  const spade = spadeMigrationCount(
    await readFile(join(root, "spade/crates/spade-store/src/schema.rs"), "utf8"),
  );
  return ReleaseData.parse({
    ...(typeof constants === "object" && constants !== null ? constants : {}),
    spade,
  });
}
