import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeChecker } from "@ace/marketplace/signer";
import { z } from "zod";
import { spadeProgram } from "../bot-kit/test.ts";

/*
 * What the maintainer's signer reads a bot package's WebAssembly components with (ADR 0203 §5):
 * Spade's own program (`spade --code-check`), which parses each component with `wasmparser` and
 * holds it to Spade's world and its manifest entry, run on the bytes the market stored, written
 * to a throwaway folder. Nothing runs: the folder is only read.
 */

/** How long reading one package's components may take. */
const TIME_MS = 60_000;

/** What `spade --code-check` prints. */
const Report = z.object({
  name: z.string().nullable(),
  problems: z.array(z.string()),
  components: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      sha256: z.string(),
      imports: z.array(z.string()),
      exports: z.array(z.string()),
      review: z.string(),
    }),
  ),
});

/** The checker for this machine's Spade program; undefined when there is none. */
export async function signerCodeChecker(
  env: Readonly<Record<string, string | undefined>>,
  entry: string | undefined,
): Promise<CodeChecker | undefined> {
  const program = await spadeProgram(env, entry);
  if (!program) return undefined;
  return async (files) => {
    const folder = await mkdtemp(join(tmpdir(), "ace-sign-code-"));
    try {
      for (const file of files) {
        // The signer checked the archive first: its paths are relative and stay inside.
        const path = join(folder, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, { mode: 0o600 });
      }
      const stdout = await new Promise<string>((done, fail) => {
        execFile(
          program,
          ["--code-check", folder],
          {
            env: { PATH: process.env.PATH ?? "", HOME: folder, TMPDIR: folder },
            timeout: TIME_MS,
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, printed) => {
            // Exit 1 is a report of problems; anything else is Spade's program failing.
            if (error && error.code !== 1) fail(new Error(`spade --code-check: ${error.message}`));
            else done(printed);
          },
        );
      });
      const report = Report.parse(JSON.parse(stdout));
      return { problems: report.problems, components: report.components };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}
