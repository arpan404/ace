import { expect, it } from "vitest";
import { githubAvatarUrl } from "./avatar-url.ts";

it("a GitHub user or app avatar is fetched from its fixed host at the size the app draws", () => {
  expect(githubAvatarUrl("https://avatars.githubusercontent.com/u/1234567?v=4")).toBe(
    "https://avatars.githubusercontent.com/u/1234567?v=4&s=64",
  );
  expect(githubAvatarUrl("https://avatars.githubusercontent.com/in/15368?v=4")).toBe(
    "https://avatars.githubusercontent.com/in/15368?v=4&s=64",
  );
});

it("a private avatar keeps the token GitHub gave it, and nothing else from the query", () => {
  expect(
    githubAvatarUrl("https://avatars.githubusercontent.com/u/42?u=ab12cd34ef&v=4&s=999&x=evil"),
  ).toBe("https://avatars.githubusercontent.com/u/42?u=ab12cd34ef&v=4&s=64");
});

it("no URL can make the daemon fetch from another host, path or scheme", () => {
  for (const reported of [
    "http://avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com.evil.test/u/1",
    "https://evil.test/u/1",
    "https://127.0.0.1/u/1",
    "https://avatars.githubusercontent.com:8443/u/1",
    "https://user:pass@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com/u/1/../../admin",
    "https://avatars.githubusercontent.com/u/abc",
    "https://avatars.githubusercontent.com/someone",
    "https://ghe.example.com/avatars/u/1?v=4",
    "not a url",
  ])
    expect(githubAvatarUrl(reported), reported).toBeUndefined();
});
