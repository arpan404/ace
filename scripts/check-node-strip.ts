import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule } from "node:vm";

/*
 * Fails when a tracked TypeScript source doesn't become JavaScript under Node's own type
 * stripping. Release builds run the CLI and daemon on Node, which strips each `.ts` module as it
 * loads it; `tsc --erasableSyntaxOnly` and oxlint judge TypeScript, not what Node's stripper
 * makes of it. Node 26 leaves `private` in place before a member named `declare`, so a file
 * both of them accept fails to load at runtime ("Unexpected identifier 'declare'"). Each file
 * is stripped and parsed as a module, never run. Run with `--experimental-vm-modules`.
 */
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.mts"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => path && !path.endsWith(".d.ts"));

/** Why `source` doesn't load as a module once Node strips its types; undefined when it does. */
function unloadable(path: string, source: string): string | undefined {
  try {
    const compiled = new SourceTextModule(stripTypeScriptTypes(source, { mode: "strip" }), {
      identifier: path,
    });
    // Compiled only: nothing is linked or run.
    return compiled.status === "unlinked" ? undefined : `compiled to ${compiled.status}`;
  } catch (error) {
    return error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  }
}

const broken = tracked.flatMap((path) => {
  const why = unloadable(path, readFileSync(path, "utf8"));
  return why === undefined ? [] : [`${path}: ${why}`];
});

if (broken.length > 0) {
  for (const line of broken)
    process.stderr.write(`${line} (after Node's type stripping; write it so Node can erase it)\n`);
  process.exit(1);
}
process.stdout.write(
  `All ${tracked.length} TypeScript sources strip to JavaScript Node can load.\n`,
);
