import type { MarketVerificationProof } from "@ace/protocol/marketplace";

/*
 * Publisher verification proofs (ADR 0173 §13). Every fetch is https only, follows no redirect
 * (any 3xx fails), refuses IP-literal, localhost and private-suffix hosts, stops after 5 seconds
 * and reads at most 4 KiB. The checks are pure over an injected fetch, so tests run them with a
 * fake; the Worker passes its own.
 */

export type ProofFetch = (url: string, init: RequestInit) => Promise<Response>;

export const proofLimits = { timeoutMs: 5_000, maxBytes: 4 * 1024 } as const;

const privateSuffixes = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "home.arpa",
  "test",
  "invalid",
  "example",
  "onion",
] as const;

/** Why a host can't be fetched for a proof, or undefined when it can. */
export function hostProblem(host: string): string | undefined {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name.startsWith("[") || /^[\d.]+$/.test(name) || /^0x/i.test(name) || name.includes(":"))
    return "A proof is never read from an IP address.";
  if (!name.includes(".")) return "A proof's host needs a public domain name.";
  if (privateSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`)))
    return "A proof is never read from a local or private host.";
  return undefined;
}

export type Fetched = { ok: true; text: string } | { ok: false; problem: string };

/** Reads `url` under the proof rules. */
export async function fetchProof(
  url: string,
  fetch: ProofFetch,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, problem: "That isn't an address." };
  }
  if (parsed.protocol !== "https:")
    return { ok: false, problem: "A proof is read over https only." };
  if (parsed.username || parsed.password)
    return { ok: false, problem: "A proof's address can't hold credentials." };
  const host = hostProblem(parsed.hostname);
  if (host) return { ok: false, problem: host };
  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(proofLimits.timeoutMs),
      headers: { "user-agent": "ace-market-verify", ...headers },
    });
  } catch {
    return { ok: false, problem: `${parsed.hostname} didn't answer within 5 seconds.` };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return {
      ok: false,
      problem: `${parsed.hostname} answered with a redirect; proofs follow none.`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, problem: `${parsed.hostname} answered ${response.status}.` };
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > proofLimits.maxBytes) {
    await response.body?.cancel();
    return { ok: false, problem: "The answer is over 4 KB." };
  }
  const bytes = await readAtMost(response, proofLimits.maxBytes);
  if (!bytes) return { ok: false, problem: "The answer is over 4 KB." };
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function readAtMost(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const holds = (text: string, token: string) =>
  text.split(/\s+/).some((word) => word === token || word === `ace-market-verify=${token}`);

/** The TXT records of `domain` through Cloudflare's DNS-over-HTTPS JSON. */
async function txtRecords(domain: string, fetch: ProofFetch): Promise<string[] | string> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
  const fetched = await fetchProof(url, fetch, { accept: "application/dns-json" });
  if (!fetched.ok) return fetched.problem;
  try {
    const body = JSON.parse(fetched.text) as { Answer?: { type?: number; data?: unknown }[] };
    return (body.Answer ?? [])
      .filter((answer) => answer.type === 16 && typeof answer.data === "string")
      .map((answer) => String(answer.data).replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
  } catch {
    return "The DNS answer wasn't readable.";
  }
}

export type ProofResult = { passed: MarketVerificationProof } | { problem: string };

/** A domain proof: the TXT record `ace-market-verify=<token>`, or the well-known file. */
export async function checkDomain(
  domain: string,
  token: string,
  fetch: ProofFetch,
): Promise<ProofResult> {
  const host = hostProblem(domain);
  if (host) return { problem: host };
  const records = await txtRecords(domain, fetch);
  if (typeof records !== "string" && records.includes(`ace-market-verify=${token}`))
    return { passed: { kind: "domain", domain, via: "dns" } };
  const file = await fetchProof(`https://${domain}/.well-known/ace-market.txt`, fetch);
  if (file.ok && holds(file.text, token))
    return { passed: { kind: "domain", domain, via: "well-known" } };
  return {
    problem: file.ok
      ? `Neither a TXT record ace-market-verify=… on ${domain} nor its /.well-known/ace-market.txt holds the token.`
      : `No TXT record on ${domain} holds the token, and the well-known file failed: ${file.problem}`,
  };
}

/**
 * A GitHub proof: the account's newest public gist holding the token, or `.ace-market.txt` in
 * its public profile repository (`<login>/<login>`) or organisation repository
 * (`<login>/.github`).
 */
export async function checkGithub(
  login: string,
  token: string,
  fetch: ProofFetch,
): Promise<ProofResult> {
  const gists = await fetchProof(
    `https://api.github.com/users/${encodeURIComponent(login)}/gists?per_page=1`,
    fetch,
    { accept: "application/vnd.github+json" },
  );
  if (gists.ok) {
    const raw = gistRaw(gists.text, login);
    if (raw) {
      const file = await fetchProof(raw, fetch);
      if (file.ok && holds(file.text, token))
        return { passed: { kind: "github", login, via: "gist" } };
    }
  }
  for (const repo of [login, ".github"]) {
    const file = await fetchProof(
      `https://raw.githubusercontent.com/${login}/${repo}/HEAD/.ace-market.txt`,
      fetch,
    );
    if (file.ok && holds(file.text, token))
      return { passed: { kind: "github", login, via: "repository" } };
  }
  return {
    problem: `Neither ${login}'s newest public gist nor .ace-market.txt in ${login}/${login} or ${login}/.github holds the token.`,
  };
}

/** The raw address of the first file in a gist listing, if it is the login's own gist. */
function gistRaw(text: string, login: string): string | undefined {
  try {
    const list = JSON.parse(text) as {
      owner?: { login?: unknown };
      files?: Record<string, { raw_url?: unknown }>;
    }[];
    const gist = list[0];
    if (!gist || String(gist.owner?.login ?? "").toLowerCase() !== login.toLowerCase())
      return undefined;
    const raw = Object.values(gist.files ?? {})[0]?.raw_url;
    if (typeof raw !== "string") return undefined;
    const url = new URL(raw);
    return url.hostname === "gist.githubusercontent.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
