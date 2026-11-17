import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseData } from "@ace/protocol";
import { spadeMigrationCount } from "../src/packaging/release-data.ts";

/**
 * The data formats of the source tree at `root` (ADR 0177): `HOME_FORMAT_VERSION`, the daemon's
 * `schemaVersion`, notify's `FORMAT` and Spade's migration count. The three TypeScript constants
 * are imported from that tree in a child process, so the numbers are the ones its own code
 * computes, and a checkout of an older tag answers for itself instead of for this build. The
 * checkout needs its dependencies installed (`bun install`).
 *
 * Spade's number comes from `spadeBinary`, the server the release ships, asked with
 * `--schema-version`: a prebuilt `ACE_SPADE_SERVER_BIN` may come from another commit, so its
 * number must match what `spade/` at this commit migrates to, or the release stops. Without a
 * binary (an older tag's checkout, whose binary can't say) the source's count is used.
 */
export async function releaseDataAt(root: string, spadeBinary?: string): Promise<ReleaseData> {
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
  const source = spadeMigrationCount(
    await readFile(join(root, "spade/crates/spade-store/src/schema.rs"), "utf8"),
  );
  const spade = spadeBinary ? shippedSpadeSchema(spadeBinary) : source;
  if (spade !== source)
    throw new Error(
      `The Spade server that ships (${spadeBinary}) migrates to schema ${spade}, but spade/ at this commit migrates to ${source}. Rebuild it from this commit, or unset ACE_SPADE_SERVER_BIN.`,
    );
  return ReleaseData.parse({
    ...(typeof constants === "object" && constants !== null ? constants : {}),
    spade,
  });
}

/** What `<binary> --schema-version` prints: the schema the shipped Spade migrates to. */
function shippedSpadeSchema(binary: string): number {
  let output: string;
  try {
    output = execFileSync(binary, ["--schema-version"], { encoding: "utf8", timeout: 30_000 });
  } catch (error) {
    throw new Error(`${binary} couldn't say its schema version; build it from this commit.`, {
      cause: error,
    });
  }
  const value = output.trim();
  if (!/^\d{1,6}$/.test(value))
    throw new Error(`${binary} --schema-version printed ${JSON.stringify(value.slice(0, 80))}`);
  return Number(value);
}
