import { expect, test } from "vitest";
import { matchRedirect, redirectAcceptable, redirectTarget } from "./redirects.ts";

test("redirects may be HTTPS, loopback HTTP or an app's own scheme, without a fragment", () => {
  for (const ok of [
    "https://client.example/cb",
    "http://localhost:3000/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:9/cb",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "com.example.app:/oauth2redirect",
  ])
    expect(redirectAcceptable(ok), ok).toBe(true);
  for (const bad of [
    "http://client.example/cb",
    "https://client.example/cb#x",
    "cursor://cb#frag",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "blob:https://client.example/1",
    "about:blank",
    "ws://localhost/cb",
    "ftp://client.example/cb",
    "https://user:pw@client.example/cb",
    "1bad://cb",
    "nope",
  ])
    expect(redirectAcceptable(bad), bad).toBe(false);
});

test("a requested redirect must equal a registered one", () => {
  const registered = [
    "https://client.example/cb",
    "http://localhost:3000/cb",
    "cursor://anysphere.cursor-mcp/oauth/callback",
  ];
  expect(matchRedirect("https://client.example/cb", registered)).toBe("https://client.example/cb");
  expect(matchRedirect("cursor://anysphere.cursor-mcp/oauth/callback", registered)).toBe(
    "cursor://anysphere.cursor-mcp/oauth/callback",
  );
  for (const near of [
    "https://client.example/cb/",
    "https://client.example/cb?x=1",
    "https://CLIENT.example/cb2",
    "http://localhost:3001/cb",
    "cursor://anysphere.cursor-mcp/oauth/other",
  ])
    expect(matchRedirect(near, registered), near).toBeUndefined();
});

test("Claude Code's sign-in comes back on a random localhost port its document registered without one", () => {
  // Its metadata document (claude.ai/oauth/claude-code-client-metadata) registers these two.
  const registered = ["http://localhost/callback", "http://127.0.0.1/callback"];
  expect(matchRedirect("http://localhost:53121/callback", registered)).toBe(
    "http://localhost:53121/callback",
  );
  expect(matchRedirect("http://127.0.0.1:61000/callback", registered)).toBe(
    "http://127.0.0.1:61000/callback",
  );
  // Path, scheme and host still match exactly.
  for (const other of [
    "http://localhost:53121/other",
    "http://localhost:53121/callback?x=1",
    "https://localhost:53121/callback",
    "http://[::1]:53121/callback",
  ])
    expect(matchRedirect(other, registered), other).toBeUndefined();
  // A registration that names a port keeps it.
  expect(matchRedirect("http://localhost:4000/cb", ["http://localhost:3000/cb"])).toBeUndefined();
});

test("the approver is told where the code goes, and when it goes to an app on this device", () => {
  expect(redirectTarget("https://claude.ai/api/mcp/auth_callback")).toEqual({
    redirectHost: "claude.ai",
    redirectKind: "web",
  });
  expect(redirectTarget("http://localhost:53121/callback")).toEqual({
    redirectHost: "localhost:53121",
    redirectKind: "this-device",
  });
  expect(redirectTarget("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
    redirectHost: "cursor:",
    redirectKind: "this-device",
  });
});
