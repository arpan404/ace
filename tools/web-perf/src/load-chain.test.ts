import { expect, test } from "vitest";
import { loadChain, type LoadRequest } from "./load-chain.ts";

const request = (
  url: string,
  initiator: string | null | undefined,
  startMs: number,
  endMs = startMs + 40,
): LoadRequest => ({ url, initiator, startMs, endMs, bytes: 100 });

test("a chunk the entry imports waits one round trip longer than the entry", () => {
  const chain = loadChain(
    [
      request("/", null, 0),
      request("/entry.js", "/", 50),
      request("/initial.js", "/entry.js", 120),
      request("/thread.js", "/initial.js", 400),
    ],
    500,
  );
  expect(chain).toEqual({
    requests: 4,
    bytes: 400,
    roundTrips: 4,
    path: ["/", "/entry.js", "/initial.js", "/thread.js"],
  });
});

test("a chunk the page preloads is one round trip after the page, however late it starts", () => {
  const chain = loadChain(
    [
      request("/", null, 0),
      request("/entry.js", "/", 50),
      request("/thread.js", "/", 60),
      request("/initial.js", "/entry.js", 120),
    ],
    500,
  );
  expect(chain.roundTrips).toBe(3);
  expect(chain.path).toEqual(["/", "/entry.js", "/initial.js"]);
});

test("requests after first content are left out", () => {
  const chain = loadChain(
    [request("/", null, 0), request("/entry.js", "/", 50), request("/later.js", "/entry.js", 900)],
    500,
  );
  expect(chain.requests).toBe(2);
  expect(chain.roundTrips).toBe(2);
});

test("a preload a script added comes after the request that finished last before it", () => {
  const chain = loadChain(
    [
      request("/", null, 0, 40),
      request("/entry.js", "/", 50, 100),
      request("/initial.js", "/entry.js", 120, 300),
      request("/thread.js", undefined, 310),
    ],
    500,
  );
  expect(chain.roundTrips).toBe(4);
  expect(chain.path).toEqual(["/", "/entry.js", "/initial.js", "/thread.js"]);
});

test("a request named by itself starts its own chain", () => {
  const chain = loadChain([request("/a.js", "/a.js", 20)], 500);
  expect(chain.roundTrips).toBe(1);
});
