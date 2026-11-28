/**
 * Strict pairing-link parsing for Android production pairing.
 *
 * Aligned with the iOS `PairingLink.parse` rules (`apps/ios/Sources/Models/PairingLink.swift`)
 * and the shared fragment layout (`packages/client/src/pairing-link.ts`):
 * `https://host:port/pair#fingerprint=…&code=…&scopes=…`, or a separately served
 * web app (for example `app.acehq.dev`) that names the computer in `host=`.
 * The fragment carries the code and pin, so no HTTP request may carry them and
 * networking must use only scheme, host and port.
 *
 * The shared `parsePairingLink` helper stays lenient (it accepts `http` and
 * empty codes) because browsers and the CLI have their own trust stories.
 * This module is the strict native gate: HTTPS only, a non-empty code and a
 * valid pin are required before anything is shown or sent. It parses only; it
 * performs no networking and never logs the code or pin.
 */

export { isPin } from "../security/trust.ts";
import { isPin } from "../security/trust.ts";

export type PairingLinkProblem =
  | "not-a-link"
  | "insecure"
  | "wrong-path"
  | "credentials-in-url"
  | "missing-code"
  | "invalid-pin";

export class PairingLinkError extends Error {
  readonly problem: PairingLinkProblem;
  constructor(problem: PairingLinkProblem) {
    super(pairingLinkMessage(problem));
    this.name = "PairingLinkError";
    this.problem = problem;
  }
}

function pairingLinkMessage(problem: PairingLinkProblem): string {
  switch (problem) {
    case "not-a-link":
      return "That isn't an ace pairing link. On your computer, run `ace pair` or open Settings › Machines and devices.";
    case "insecure":
      return "Pairing links must use HTTPS from your own computer.";
    case "wrong-path":
    case "credentials-in-url":
      return "Use the complete pairing link from your computer, unchanged.";
    case "missing-code":
      return "This link has no pairing code. Create a new link on your computer.";
    case "invalid-pin":
      return "This link has no valid computer fingerprint, so it can't be verified.";
  }
}

export interface AndroidPairingLink {
  /** The daemon's HTTPS origin with a trailing slash; the only network authority. */
  readonly daemonOrigin: string;
  /** Pinned WSS endpoint derived from the daemon origin: same host and port, path `/`. */
  readonly socketUrl: string;
  /** Host (and port) shown on the confirm screen. Never an identity proof. */
  readonly displayHost: string;
  readonly code: string;
  /** Lowercase 64-hex SHA-256 DER SPKI pin from the fragment. */
  readonly fingerprint: string;
  readonly scopes: readonly string[];
}

/** Maximum pairing-link size in UTF-8 bytes, matching the wire contract. */
const MAX_LINK_BYTES = 4096;
/** Maximum pairing-code size in UTF-8 bytes, matching the wire contract. */
const MAX_CODE_BYTES = 256;

const textEncoder = new TextEncoder();

function utf8Length(text: string): number {
  return textEncoder.encode(text).length;
}

function fail(problem: PairingLinkProblem): never {
  throw new PairingLinkError(problem);
}

/**
 * Parse pasted or scanned text into a pairing link. Throws `PairingLinkError`
 * with an actionable message; the thrown message never contains the link.
 */
export function parseAndroidPairingLink(text: string): AndroidPairingLink {
  const trimmed = text.trim();
  if (trimmed === "" || utf8Length(trimmed) > MAX_LINK_BYTES) fail("not-a-link");
  let outer: URL;
  try {
    outer = new URL(trimmed);
  } catch {
    fail("not-a-link");
  }
  if (outer.protocol !== "https:" && outer.protocol !== "http:") fail("not-a-link");
  if (outer.protocol !== "https:") fail("insecure");
  if (outer.username !== "" || outer.password !== "" || outer.search !== "") {
    fail("credentials-in-url");
  }
  if (outer.pathname !== "/pair") fail("wrong-path");

  const fragment = parseFragment(outer.hash.slice(1));
  const code = fragment.get("code") ?? "";
  if (code === "" || utf8Length(code) > MAX_CODE_BYTES) fail("missing-code");
  const pin = (fragment.get("fingerprint") ?? "").toLowerCase();
  if (!isPin(pin)) fail("invalid-pin");

  let daemon: URL;
  const named = fragment.get("host");
  if (named === undefined) {
    daemon = outer;
  } else {
    let address: URL;
    try {
      address = new URL(named);
    } catch {
      fail("not-a-link");
    }
    if (address.protocol !== "https:" && address.protocol !== "http:") fail("not-a-link");
    if (address.protocol !== "https:") fail("insecure");
    if (address.username !== "" || address.password !== "") fail("credentials-in-url");
    if (address.search !== "" || address.hash !== "") fail("not-a-link");
    if (address.pathname !== "" && address.pathname !== "/") fail("not-a-link");
    daemon = address;
  }
  const host = daemon.host;
  if (host === "") fail("not-a-link");
  const daemonOrigin = `${daemon.protocol}//${host}/`;
  const socketUrl = `wss://${host}/`;
  const scopes = (fragment.get("scopes") ?? "").split(",").filter((scope) => scope !== "");
  return { daemonOrigin, socketUrl, displayHost: host, code, fingerprint: pin, scopes };
}

/**
 * Parse a URL fragment as `name=value&…` pairs. Unlike `URLSearchParams`,
 * a literal `+` stays a `+`: iOS parses the fragment with `URLComponents`
 * (`PairingLink.parse`), which does not treat `+` as a space, so a code
 * containing `+` must survive unchanged on Android too.
 */
function parseFragment(fragment: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of fragment.split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const rawName = separator < 0 ? pair : pair.slice(0, separator);
    const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
    if (!values.has(name)) values.set(name, value);
  }
  return values;
}

/** Groups of four hex characters for comparing against the computer's screen. */
export function fingerprintGroups(fingerprint: string): string {
  const groups: string[] = [];
  for (let offset = 0; offset + 4 <= fingerprint.length; offset += 4) {
    groups.push(fingerprint.slice(offset, offset + 4));
  }
  const rest = fingerprint.slice(groups.length * 4);
  if (rest !== "") groups.push(rest);
  return groups.join(" ");
}

/**
 * The grant summary for the confirm screen. The host chose these scopes and
 * redemption cannot add any; an empty list means the host used its default.
 */
export function accessSummary(scopes: readonly string[]): string {
  if (scopes.length === 0) return "Chosen by your computer";
  const canOperate = scopes.includes("operate") || scopes.includes("admin");
  const access = scopes.includes("admin")
    ? "Administrator"
    : canOperate
      ? "View and act"
      : "View only";
  const extras: string[] = [];
  if (scopes.includes("projects")) extras.push("Projects");
  if (scopes.includes("accounts")) extras.push("Accounts");
  return [access, ...extras].join(" · ");
}
