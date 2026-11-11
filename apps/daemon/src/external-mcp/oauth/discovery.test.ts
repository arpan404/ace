import { expect, test } from "vitest";
import { namesResource, outsideBase, relativePath, resourceMetadataUrl } from "./base.ts";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata.ts";

const relay = outsideBase("relay", "https://relay.example/m/host-1");
const local = outsideBase("local", "http://127.0.0.1:4100");

test("each base names its own MCP URL as the resource and itself as the issuer", () => {
  expect(protectedResourceMetadata(relay, "Studio")).toMatchObject({
    resource: "https://relay.example/m/host-1/mcp",
    authorization_servers: ["https://relay.example/m/host-1"],
    scopes_supported: ["threads:read"],
  });
  const server = authorizationServerMetadata(relay);
  expect(server).toMatchObject({
    issuer: "https://relay.example/m/host-1",
    authorization_endpoint: "https://relay.example/m/host-1/authorize",
    token_endpoint: "https://relay.example/m/host-1/token",
    registration_endpoint: "https://relay.example/m/host-1/register",
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
  expect(server.token_endpoint_auth_methods_supported).toContain("none");
  expect(server.scopes_supported).toEqual([
    "threads:read",
    "threads:start",
    "threads:message",
    "threads:stop",
    "browser",
    "computer",
  ]);
});

test("the resource metadata URL inserts the well-known path before the resource path", () => {
  expect(resourceMetadataUrl(relay)).toBe(
    "https://relay.example/.well-known/oauth-protected-resource/m/host-1/mcp",
  );
  expect(resourceMetadataUrl(local)).toBe(
    "http://127.0.0.1:4100/.well-known/oauth-protected-resource/mcp",
  );
});

test("paths are read below the base, and a request outside it has none", () => {
  const at = (url: string) => relativePath(new Request(url), relay);
  expect(at("https://relay.example/m/host-1/token")).toBe("/token");
  expect(at("https://relay.example/m/host-1/.well-known/oauth-authorization-server")).toBe(
    "/.well-known/oauth-authorization-server",
  );
  expect(at("https://relay.example/m/host-10/token")).toBeUndefined();
  expect(relativePath(new Request("http://127.0.0.1:4100/mcp"), local)).toBe("/mcp");
});

test("a resource matches only this base's MCP URL", () => {
  expect(namesResource("https://relay.example/m/host-1/mcp", relay)).toBe(true);
  expect(namesResource("HTTPS://RELAY.EXAMPLE/m/host-1/mcp/", relay)).toBe(true);
  for (const other of [
    "https://relay.example/m/host-2/mcp",
    "https://relay.example/m/host-1",
    "https://relay.example/m/host-1/mcp?x=1",
    "https://relay.example/m/host-1/mcp#f",
    "http://relay.example/m/host-1/mcp",
    "not a url",
  ])
    expect(namesResource(other, relay), other).toBe(false);
});
