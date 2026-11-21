import { expect, test } from "vitest";
import { outsideProof, type Forwarded } from "./outside-proof.ts";

const key = "k".repeat(64);
const signed: Forwarded = {
  time: 1_000,
  nonce: "nonce-0123456789ab",
  method: "POST",
  route: "/v1/outside/mcp",
  sender: "ace:outside:g1",
  name: "Claude%20Code",
  headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "a__b" },
  body: Buffer.from('{"jsonrpc":"2.0"}'),
};

test("the stamp on a forwarded request is the one Spade checks", () => {
  // The vector Spade's `teams::proof` tests check for the same request.
  expect(outsideProof(key, signed)).toBe(
    "bc74f66040710da0dc6b7e0978f1ea6a12cd759a52f4052a2e153f2f0bc61029",
  );
});

test("the stamp changes with the route, method, nonce or a protocol header, so none can be swapped", () => {
  const proof = outsideProof(key, signed);
  for (const moved of [
    { ...signed, route: "/v1/outside/a2a" },
    { ...signed, method: "GET" },
    { ...signed, nonce: "nonce-other-012345" },
    { ...signed, headers: { ...signed.headers, "mcp-method": "tools/list" } },
    { ...signed, headers: { ...signed.headers, "a2a-version": "" } },
  ])
    expect(outsideProof(key, moved)).not.toBe(proof);
});
