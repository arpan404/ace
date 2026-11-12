import { expect, it } from "vitest";
import { hostId, keyPair } from "@ace/secure-channel";
import { forwardPath } from "./http-path.ts";

const id = hostId(keyPair().publicKey);
const at = (path: string) => forwardPath(new URL(`https://relay.example${path}`));

it("a path under /m/<hostId> goes to that machine with the prefix removed and the query kept", () => {
  expect(at(`/m/${id}/mcp?cursor=2`)).toEqual({
    hostId: id,
    prefix: `/m/${id}`,
    path: "/mcp?cursor=2",
  });
  expect(at(`/m/${id}/authorize`)?.path).toBe("/authorize");
  expect(at(`/m/${id}/.well-known/oauth-protected-resource/mcp`)?.path).toBe(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(at(`/m/${id}`)?.path).toBe("/");
  expect(at(`/m/${id}/`)?.path).toBe("/");
});

it("RFC 9728 and RFC 8414 inserted metadata paths reach the same machine as its own root form", () => {
  expect(at(`/.well-known/oauth-protected-resource/m/${id}/mcp`)).toEqual({
    hostId: id,
    prefix: `/m/${id}`,
    path: "/.well-known/oauth-protected-resource/mcp",
  });
  expect(at(`/.well-known/oauth-authorization-server/m/${id}`)).toEqual({
    hostId: id,
    prefix: `/m/${id}`,
    path: "/.well-known/oauth-authorization-server",
  });
  expect(at(`/.well-known/openid-configuration/m/${id}`)?.path).toBe(
    "/.well-known/openid-configuration",
  );
});

it("malformed host ids, other well-known names and relay endpoints are not forwarded", () => {
  expect(at("/m/not-a-host/mcp")).toBeUndefined();
  expect(at(`/m/${id.toLowerCase()}/mcp`)).toBeUndefined();
  expect(at(`/m/${id}x/mcp`)).toBeUndefined();
  expect(at("/m/")).toBeUndefined();
  expect(at(`/.well-known/security.txt/m/${id}`)).toBeUndefined();
  expect(at(`/mcp/${id}`)).toBeUndefined();
  expect(at("/host")).toBeUndefined();
  expect(at("/v1/me")).toBeUndefined();
});
