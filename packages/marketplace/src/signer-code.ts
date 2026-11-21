import type { ArchiveFile } from "./archive.ts";
import type { Inspection } from "./checks/index.ts";

/*
 * A bot package's WebAssembly components, read by the signer before it signs (ADR 0203 §5). The
 * Worker runs TypeScript and checks only a component's header, size and the manifest's list; the
 * signer runs Spade's own program (`spade --code-check`), which parses each component with
 * `wasmparser`, lists what it really imports and exports, and refuses anything outside Spade's
 * world or a binary whose imports differ from its manifest entry. A version it refuses is
 * refused for good; one this machine can't read waits for a signer that can. Pure, but for the
 * checker passed in.
 */

/** What reading a package's components found. */
export interface CodeCheckOutcome {
  /** Every reason its code is refused; empty when it passes. */
  problems: string[];
  /** Each component as its binary reads, with its review row. */
  components: {
    name: string;
    file: string;
    sha256: string;
    imports: string[];
    exports: string[];
    review: string;
  }[];
}

/**
 * Reads a bot package's components from its files; throws when they couldn't be read at all
 * (Spade's program missing or broken), which is never a failure of the package.
 */
export type CodeChecker = (files: readonly ArchiveFile[]) => Promise<CodeCheckOutcome>;

/** Whether a version is a bot package with code the signer must read before signing. */
export function hasCode(inspection: Inspection | undefined): boolean {
  return inspection?.type === "spade-bot" && (inspection.recipe.code?.length ?? 0) > 0;
}

/** Why a version whose code was refused isn't signed, in the publisher's words. */
export function codeReason(outcome: CodeCheckOutcome): string {
  const first = outcome.problems[0] ?? "a component isn't one Spade runs";
  const more = outcome.problems.length - 1;
  return `Its code was refused when ace's market read it: ${first}${more > 0 ? ` (and ${more} more)` : ""}`.slice(
    0,
    500,
  );
}

/** A package's components read, or why they couldn't be here: then nothing is signed or refused. */
export async function readCode(
  checkCode: CodeChecker | undefined,
  files: readonly ArchiveFile[],
): Promise<CodeCheckOutcome | { refused: string }> {
  if (!checkCode)
    return {
      refused:
        "Its code needs Spade's program to read, which this signer doesn't have; it waits for one that does.",
    };
  try {
    return await checkCode(files);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { refused: `Its code couldn't be read here: ${why}`.slice(0, 500) };
  }
}
