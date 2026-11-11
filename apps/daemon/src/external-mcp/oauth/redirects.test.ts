import { expect, test } from "vitest";
import { loopbackOnly, matchRedirect, redirectAcceptable } from "./redirects.ts";

test("redirects must be HTTPS or loopback HTTP, without a fragment", () => {
  for (const ok of [
    "https://client.example/cb",
    "http://localhost:3000/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:9/cb",
  ])
    expect(redirectAcceptable(ok), ok).toBe(true);
  for (const bad of [
    "http://client.example/cb",
    "https://client.example/cb#x",
    "cursor://oauth/callback",
    "javascript:alert(1)",
    "https://user:pw@client.example/cb",
    "nope",
  ])
    expect(redirectAcceptable(bad), bad).toBe(false);
});

test("a requested redirect must equal a registered one", () => {
  const registered = ["https://client.example/cb", "http://localhost:3000/cb"];
  expect(matchRedirect("https://client.example/cb", registered)).toBe("https://client.example/cb");
  for (const near of [
    "https://client.example/cb/",
    "https://client.example/cb?x=1",
    "https://CLIENT.example/cb2",
    "http://localhost:3001/cb",
  ])
    expect(matchRedirect(near, registered), near).toBeUndefined();
});

test("a loopback IP redirect may name any port, as native apps need", () => {
  const registered = ["http://127.0.0.1/callback"];
  expect(matchRedirect("http://127.0.0.1:53121/callback", registered)).toBe(
    "http://127.0.0.1:53121/callback",
  );
  expect(matchRedirect("http://127.0.0.1:53121/other", registered)).toBeUndefined();
  expect(matchRedirect("http://localhost:53121/callback", registered)).toBeUndefined();
});

test("redirects that all stay on this computer are flagged", () => {
  expect(loopbackOnly(["http://localhost:3000/cb"])).toBe(true);
  expect(loopbackOnly(["http://localhost:3000/cb", "https://client.example/cb"])).toBe(false);
});
