import { describe, expect, it } from "vitest";
import { checkDomain, checkGithub, fetchProof, type ProofFetch } from "./verify-proofs.ts";

/* Proof checks over a fake fetch (ADR 0173 §13): no network. */

const token = "t".repeat(43);

/** A fake web: each address answers what the table says, and every call is recorded. */
function web(table: Record<string, () => Response>) {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetch: ProofFetch = async (url, init) => {
    asked.push({ url, init });
    const answer = table[url];
    return answer ? answer() : new Response("missing", { status: 404 });
  };
  return { fetch, asked };
}

const dns = (domain: string) =>
  `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
const txt =
  (...records: string[]) =>
  () =>
    Response.json({ Answer: records.map((data) => ({ type: 16, data: `"${data}"` })) });

const silent: ProofFetch = async () => {
  throw new DOMException("timed out", "TimeoutError");
};

describe("proof fetches", () => {
  it.each([
    ["plain http", "http://example.org/.well-known/ace-market.txt", "https only"],
    ["an IPv4 literal", "https://192.168.1.10/x", "IP address"],
    ["an IPv6 literal", "https://[::1]/x", "IP address"],
    ["localhost", "https://localhost/x", "public domain"],
    ["a private suffix", "https://printer.internal/x", "private"],
    ["a .local host", "https://box.local/x", "private"],
    ["credentials in the address", "https://user:pw@example.org/x", "credentials"],
  ])("%s is refused before anything is fetched", async (_label, url, words) => {
    const { fetch, asked } = web({});
    const result = await fetchProof(url, fetch);
    expect(result).toEqual({ ok: false, problem: expect.stringContaining(words) });
    expect(asked).toEqual([]);
  });

  it("a redirect fails the proof and isn't followed", async () => {
    const url = "https://example.org/.well-known/ace-market.txt";
    const { fetch, asked } = web({
      [url]: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    });
    const result = await fetchProof(url, fetch);
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining("redirect") });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.init.redirect).toBe("manual");
    expect(asked[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an answer over 4 KB fails, declared or streamed", async () => {
    const declared = "https://example.org/declared";
    const streamed = "https://example.org/streamed";
    const big = "x".repeat(5000);
    const { fetch } = web({
      [declared]: () => new Response(big, { headers: { "content-length": "5000" } }),
      [streamed]: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(big));
              controller.close();
            },
          }),
        ),
    });
    for (const url of [declared, streamed])
      expect(await fetchProof(url, fetch)).toMatchObject({
        ok: false,
        problem: expect.stringContaining("4 KB"),
      });
  });

  it("a fetch that never answers is reported, not thrown", async () => {
    expect(await fetchProof("https://example.org/x", silent)).toMatchObject({ ok: false });
  });
});

describe("domain and GitHub proofs", () => {
  it("a TXT record with the token passes by DNS", async () => {
    const { fetch, asked } = web({ [dns("example.org")]: txt(`ace-market-verify=${token}`) });
    expect(await checkDomain("example.org", token, fetch)).toEqual({
      passed: { kind: "domain", domain: "example.org", via: "dns" },
    });
    expect(new Headers(asked[0]?.init.headers).get("accept")).toBe("application/dns-json");
  });

  it("the well-known file passes when no TXT record holds the token", async () => {
    const { fetch } = web({
      [dns("example.org")]: txt("v=spf1 -all"),
      "https://example.org/.well-known/ace-market.txt": () => new Response(`${token}\n`),
    });
    expect(await checkDomain("example.org", token, fetch)).toEqual({
      passed: { kind: "domain", domain: "example.org", via: "well-known" },
    });
  });

  it("another token fails the domain", async () => {
    const { fetch } = web({
      [dns("example.org")]: txt(`ace-market-verify=${"o".repeat(43)}`),
      "https://example.org/.well-known/ace-market.txt": () => new Response("o".repeat(43)),
    });
    expect(await checkDomain("example.org", token, fetch)).toHaveProperty("problem");
  });

  it("a GitHub account passes with its profile repository's file", async () => {
    const { fetch } = web({
      "https://raw.githubusercontent.com/octo/octo/HEAD/.ace-market.txt": () => new Response(token),
    });
    expect(await checkGithub("octo", token, fetch)).toEqual({
      passed: { kind: "github", login: "octo", via: "repository" },
    });
  });

  it("a GitHub account passes with its newest public gist, never another owner's", async () => {
    const raw = "https://gist.githubusercontent.com/octo/abc/raw/proof.txt";
    const gist = (owner: string) => () =>
      Response.json([{ owner: { login: owner }, files: { "proof.txt": { raw_url: raw } } }]);
    const listing = "https://api.github.com/users/octo/gists?per_page=1";
    const mine = web({ [listing]: gist("octo"), [raw]: () => new Response(token) });
    expect(await checkGithub("octo", token, mine.fetch)).toEqual({
      passed: { kind: "github", login: "octo", via: "gist" },
    });
    const theirs = web({ [listing]: gist("someone"), [raw]: () => new Response(token) });
    expect(await checkGithub("octo", token, theirs.fetch)).toHaveProperty("problem");
  });
});
