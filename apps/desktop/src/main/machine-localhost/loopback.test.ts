import { describe, expect, it } from "vitest";
import { blocksLoopbackRequest } from "./loopback.ts";

describe("a device tab's request to the machine's localhost", () => {
  it.each([
    [
      "a page on localhost loads its script",
      "http://localhost:3000/app.js",
      "script",
      "http://localhost:3000/",
      false,
    ],
    [
      "a page on localhost calls another port",
      "http://localhost:4000/api",
      "xhr",
      "http://localhost:3000/",
      false,
    ],
    [
      "a page on 127.0.0.1 opens a websocket",
      "ws://127.0.0.1:5173/",
      "webSocket",
      "http://127.0.0.1:5173/",
      false,
    ],
    [
      "an OAuth redirect comes back to localhost",
      "http://localhost:3000/callback?code=1",
      "mainFrame",
      "https://accounts.example.com/",
      false,
    ],
    ["a typed address opens localhost", "http://localhost:3000/", "mainFrame", undefined, false],
    [
      "a public page fetches localhost",
      "http://localhost:3000/secret",
      "xhr",
      "https://evil.example/",
      true,
    ],
    [
      "a public page frames localhost",
      "http://localhost:3000/",
      "subFrame",
      "https://evil.example/",
      true,
    ],
    [
      "a public page loads an image from [::1]",
      "http://[::1]:8080/x.png",
      "image",
      "https://evil.example/",
      true,
    ],
    [
      "a public page opens a websocket to 127.0.0.1",
      "ws://127.0.0.1:9229/",
      "webSocket",
      "https://evil.example/",
      true,
    ],
    ["a request whose page is unknown", "http://localhost:3000/", "other", undefined, true],
    [
      "a public page loads a public script",
      "https://cdn.example/x.js",
      "script",
      "https://evil.example/",
      false,
    ],
    [
      "a localhost page loads a public script",
      "https://cdn.example/x.js",
      "script",
      "http://localhost:3000/",
      false,
    ],
  ])("%s: blocked %s", (_name, url, resourceType, topUrl, blocked) => {
    expect(blocksLoopbackRequest({ url, resourceType, topUrl })).toBe(blocked);
  });
});
