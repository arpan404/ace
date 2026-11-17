import { scanText } from "./decode.ts";

/*
 * Licence texts a Suit may hold (ADR 0173 §8). A font's licence (OFL and the like) must ship with
 * the font, so a Suit may carry plain-text licence and notice files, at its root or under
 * `assets/`. They stay inert data: UTF-8 text, size-capped, and the scanner's hidden-content and
 * secrets checks still read them; a Suit's licence is never an instruction source. Anything that
 * only looks like one (a `.txt` anywhere else, one with an executable bit) is a stray file. Pure.
 */

/** The most a single licence text may hold. */
export const MAX_LICENCE_BYTES = 256 * 1024;

/** `LICENSE`, `LICENCE`, `NOTICE`, `COPYING`, with or without `.txt` or `.md`. */
const PLAIN_NAME = /^(?:licen[cs]e|notice|copying)(?:\.(?:txt|md))?$/i;
/** `X.LICENSE`: a licence beside the file it covers. */
const SUFFIX_NAME = /^[\w. -]+\.licen[cs]e$/i;
/** `OFL.txt`, `X-OFL.txt`, `LICENSE-Foo.txt`, `Foo.license.md`: a `.txt` or `.md` that says what it is. */
const TEXT_NAME =
  /^(?:[\w. -]*[-_ .])?(?:licen[cs]e|copying|notice|ofl)(?:[-_ .][\w. -]*)?\.(?:txt|md)$/i;

/** Whether `path` is named and placed like a Suit's licence text. */
export function isLicencePath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const place = slash < 0 ? "" : path.slice(0, slash);
  if (place !== "" && place !== "assets" && !place.startsWith("assets/")) return false;
  const name = path.slice(slash + 1);
  return PLAIN_NAME.test(name) || SUFFIX_NAME.test(name) || TEXT_NAME.test(name);
}

/** What is wrong with a licence's bytes, as a rule and a sentence, or undefined when it is fine. */
export function licenceProblem(
  path: string,
  bytes: Uint8Array,
): { rule: string; message: string } | undefined {
  if (bytes.byteLength > MAX_LICENCE_BYTES)
    return {
      rule: "suit-licence-too-large",
      message: `${path} is over ${MAX_LICENCE_BYTES / 1024} KiB, more than a licence text needs`,
    };
  if (scanText(bytes)?.encoding !== "utf-8" || bytes.includes(0))
    return { rule: "suit-licence-not-text", message: `${path} isn't plain UTF-8 text` };
  return undefined;
}
