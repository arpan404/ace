import type { MarketLink, MarketProblem } from "@ace/protocol/marketplace";
import { fold, hasBidi, hasInvisible, mixedScriptWord, skeleton } from "./scan/text.ts";

/*
 * A publisher's profile rules (ADR 0173 §3, §14), shared by the Worker, the CLI and the device:
 * handles (reserved words, lookalikes by confusable skeleton, the official `ace`), display names
 * and links. Pure.
 */

export { skeleton };

/**
 * Reserved handles (ADR 0173 §3): words no publisher may take, and words that, beside `ace` in a
 * skeleton, read as official ace. Only an account on the signed official list may take `ace` or a
 * handle whose skeleton is `ace` or holds `ace` next to one of these.
 */
const RESERVED = new Set([
  "ace",
  "acehq",
  "admin",
  "official",
  "support",
  "security",
  "market",
  "marketplace",
  "spade",
  "staff",
  "moderator",
  "verified",
  "root",
  "system",
  "help",
  "api",
  "www",
  "null",
  "undefined",
  "team",
  "mod",
  "owner",
  "hq",
  "about",
  "settings",
  "login",
  "signup",
  "billing",
  "abuse",
]);

/** Reserved words that, standing beside `ace` in a skeleton, make it read as official ace. */
const ACE_QUALIFIERS = ["official", "team", "hq", "market", "support", "staff", "mod", "admin"];

/** A handle is 3 to 32 of `a-z`, `0-9` and single dashes, no leading, trailing or double dash. */
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a handle's skeleton reads as official ace: it is `ace` itself, or `ace` with one of the
 * {@link ACE_QUALIFIERS} on either side (`aceofficial`, `teamace`, `acehq`). Digit, homoglyph and
 * separator tricks are already folded by {@link skeleton}, so `4ce`, `a-c-e` and `асе` all reach
 * here as `ace`.
 */
export function readsAsAce(skel: string): boolean {
  if (skel === "ace" || skel === "aces") return true;
  for (const word of ACE_QUALIFIERS) {
    if (skel === `ace${word}` || skel === `${word}ace`) return true;
  }
  return false;
}

/** Why `handle` can't be taken by `account`, or undefined when it can. */
export function handleProblem(
  handle: string,
  options: {
    /** The account is on the signed official list (§14): only it may take `ace`. */
    official: boolean;
  },
): MarketProblem | undefined {
  if (handle.length < 3 || handle.length > 32)
    return { message: "A handle is 3 to 32 characters." };
  if (!HANDLE.test(handle))
    return {
      message: "A handle uses lower-case letters, digits and single dashes, nothing else.",
    };
  if (handle.includes("--")) return { message: "A handle has no double dash." };

  const skel = skeleton(handle);
  const parts = handle.split("-");

  // `ace` and its official-looking variants are refused for everyone but the official list.
  if (!options.official && readsAsAce(skel)) return { message: "That handle is reserved for ace." };

  if (options.official) return undefined;

  // The whole handle, or any dash-separated part, is a reserved word.
  if (RESERVED.has(handle)) return { message: `"${handle}" is a reserved handle.` };
  for (const part of parts)
    if (RESERVED.has(part) || RESERVED.has(skeleton(part)))
      return { message: `"${part}" is a reserved word.` };

  // The skeleton as a whole is a reserved word (folded tricks), or holds `ace` beside a reserved
  // qualifier (caught by readsAsAce above); also refuse a skeleton equal to a reserved word.
  if (RESERVED.has(skel)) return { message: "That handle is reserved." };

  return undefined;
}

/**
 * Why a display name can't be used: hidden characters, mixed scripts, reading as ace or "By ace"
 * (unless official), or a verified publisher's display name.
 */
export function displayNameProblem(
  name: string,
  options: { official: boolean; verified: readonly string[] },
): MarketProblem | undefined {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60)
    return { message: "A display name is 1 to 60 characters." };
  if (hasBidi(trimmed))
    return { message: "A display name has no bidirectional control character." };
  if (hasInvisible(trimmed)) return { message: "A display name has no hidden character." };
  const mixed = mixedScriptWord(trimmed);
  if (mixed) return { message: `"${mixed}" mixes letters from more than one script.` };

  if (!options.official) {
    const skel = skeleton(trimmed);
    const byAce = skeleton(trimmed.replace(/^by\s+/i, ""));
    if (readsAsAce(skel) || (/^by\s+/i.test(trimmed) && readsAsAce(byAce)))
      return { message: 'That display name reads as "ace".' };
  }

  for (const taken of options.verified)
    if (skeleton(taken) === skeleton(trimmed) && fold(taken).text !== fold(trimmed).text)
      return { message: "That display name is a verified publisher's." };

  return undefined;
}

/**
 * Why a link can't be on a profile or listing (ADR 0173 §3): `https:` only, no credentials in the
 * authority, no IP-literal host, no `localhost` or private-suffix host, at most 2048 characters.
 */
export function linkProblem(link: MarketLink): MarketProblem | undefined {
  const url = link.url;
  if (url.length > 2048) return { message: "A link is at most 2048 characters." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { message: "That link isn't a URL." };
  }
  if (parsed.protocol !== "https:") return { message: "A link must be https." };
  if (parsed.username || parsed.password)
    return { message: "A link carries no username or password." };
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return { message: "A link names a host, not an IP address." };
  if (host === "localhost" || host.endsWith(".localhost"))
    return { message: "A link isn't to localhost." };
  if (/\.(?:local|internal|lan|home|intranet|corp)$/.test(host))
    return { message: "A link isn't to a private host." };
  return undefined;
}

/** Whether `host` is an IPv4 or IPv6 literal rather than a name. */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true; // IPv6
  // Bare integer or hex forms browsers accept as IPv4.
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(host)) return true;
  return false;
}
