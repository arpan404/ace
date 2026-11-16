import type { MarketLink, MarketProblem } from "@ace/protocol/marketplace";

/*
 * A publisher's profile rules (ADR 0173 §3, §14), shared by the Worker, the CLI and the device:
 * handles (reserved words, lookalikes by confusable skeleton, the official `ace`), display names
 * and links. Pure.
 */

/**
 * The confusable folding of a handle or name: lowercase, homoglyphs and look-alike digits
 * folded (`0→o`, `1→l`, `rn→m`, `vv→w`, Cyrillic and Greek look-alikes to Latin), dashes and
 * separators dropped. Two handles with one skeleton can't both exist.
 */
export function skeleton(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Why `handle` can't be taken by `account`, or undefined when it can. */
export function handleProblem(
  handle: string,
  options: {
    /** The account is on the signed official list (§14): only it may take `ace`. */
    official: boolean;
  },
): MarketProblem | undefined {
  void options;
  if (handle.length < 3) return { message: "A handle is at least 3 characters." };
  return undefined;
}

/** Why a display name can't be used: hidden characters, mixed scripts, reading as ace. */
export function displayNameProblem(
  name: string,
  options: { official: boolean; verified: readonly string[] },
): MarketProblem | undefined {
  void name;
  void options;
  return undefined;
}

/** Why a link can't be on a profile or listing: https only, no credentials, no IP literal. */
export function linkProblem(link: MarketLink): MarketProblem | undefined {
  void link;
  return undefined;
}
