import { describe, expect, it } from "vitest";
import { blocksLoopbackRequest } from "./loopback.ts";

const localhost = "http://localhost:3000";
const evil = "https://evil.example";

describe("a device tab's request to the machine's localhost", () => {
  it.each([
    [
      "a localhost page loads its script",
      "http://localhost:3000/app.js",
      "script",
      "GET",
      localhost,
      false,
    ],
    [
      "a localhost page calls another port",
      "http://localhost:4000/api",
      "xhr",
      "POST",
      localhost,
      false,
    ],
    [
      "a 127.0.0.1 page opens a websocket",
      "ws://127.0.0.1:5173/",
      "webSocket",
      "GET",
      "http://127.0.0.1:5173",
      false,
    ],
    [
      "a localhost page's service worker fetches",
      "http://localhost:3000/api",
      "xhr",
      "GET",
      localhost,
      false,
    ],
    [
      "a localhost page frames another port",
      "http://localhost:4000/",
      "subFrame",
      "GET",
      localhost,
      false,
    ],
    ["a public page fetches localhost", "http://localhost:3000/secret", "xhr", "GET", evil, true],
    [
      "a public frame inside a localhost page fetches localhost",
      "http://localhost:3000/secret",
      "xhr",
      "GET",
      evil,
      true,
    ],
    [
      "a public frame inside a localhost page opens a websocket",
      "ws://localhost:3000/",
      "webSocket",
      "GET",
      evil,
      true,
    ],
    ["a public page frames localhost", "http://localhost:3000/", "subFrame", "GET", evil, true],
    [
      "a public page loads an image from [::1]",
      "http://[::1]:8080/x.png",
      "image",
      "GET",
      evil,
      true,
    ],
    [
      "a sandboxed frame (opaque origin) fetches localhost",
      "http://localhost:3000/",
      "xhr",
      "GET",
      "null",
      true,
    ],
    ["a request no document sent", "http://localhost:3000/", "other", "GET", undefined, true],
    [
      "a public page loads a public script",
      "https://cdn.example/x.js",
      "script",
      "GET",
      evil,
      false,
    ],
    [
      "a localhost page loads a public script",
      "https://cdn.example/x.js",
      "script",
      "GET",
      localhost,
      false,
    ],
  ])("%s: blocked %s", (_name, url, resourceType, method, initiator, blocked) => {
    expect(blocksLoopbackRequest({ url, resourceType, method, initiator })).toBe(blocked);
  });
});

describe("a device tab's top-level navigation to the machine's localhost", () => {
  it.each([
    // The person's: the browser's own navigation, with no initiator, and each redirect of it.
    ["the person types a localhost address", "GET", undefined, false],
    ["the person's load redirected to localhost with 302, 303, 307 or 308", "GET", undefined, false],
    ["the person reloads a localhost page a localhost form posted to", "POST", undefined, false],
    // A document's: Chromium names its origin on the navigation and on every redirect of it,
    // with the method that hop sends.
    ["a public page's post redirected to localhost with 301 or 302 (now a GET)", "GET", evil, false],
    ["a public page's post redirected to localhost with 303 (now a GET)", "GET", evil, false],
    ["a public page links to localhost", "GET", evil, false],
    [
      "an OAuth provider redirects back to localhost (302 or 303, now a GET)",
      "GET",
      "https://accounts.example",
      false,
    ],
    ["a localhost page posts a form to itself", "POST", localhost, false],
    ["a public page posts a form to localhost", "POST", evil, true],
    ["a public page's post is redirected to localhost with 307 or 308", "POST", evil, true],
    ["a public page sends a PUT to localhost", "PUT", evil, true],
  ])("%s: blocked %s", (_name, method, initiator, blocked) => {
    expect(
      blocksLoopbackRequest({
        url: "http://localhost:3000/cb",
        resourceType: "mainFrame",
        method,
        initiator,
      }),
    ).toBe(blocked);
  });
});
