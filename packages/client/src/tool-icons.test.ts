import type { IconsReadResponse, IconsResolveResponse, ToolIcon } from "@ace/protocol";
import { expect, test } from "vitest";
import { ToolIconCache } from "./tool-icons.ts";

const github: ToolIcon = { kind: "site", origin: "https://github.com" };
const mdn: ToolIcon = { kind: "site", origin: "https://developer.mozilla.org" };
const nothing: ToolIcon = { kind: "site", origin: "https://example.com" };
const ref = (letter: string) => letter.repeat(64);

/** A daemon that knows two sites sharing one icon; `offline` fails resolving. */
function daemon() {
  const calls: string[] = [];
  const state = { offline: false };
  const known: Record<string, string> = {
    "https://github.com": ref("a"),
    "https://developer.mozilla.org": ref("a"),
  };
  return {
    calls,
    state,
    async resolve(icons: ToolIcon[]): Promise<IconsResolveResponse> {
      calls.push(`resolve:${icons.length}`);
      if (state.offline) throw new Error("offline");
      return {
        type: "icons.resolve",
        requestId: "r",
        refs: icons.map((icon) => (icon.kind === "site" ? (known[icon.origin] ?? null) : null)),
      };
    },
    async read(id: string): Promise<IconsReadResponse> {
      calls.push(`read:${id.slice(0, 1)}`);
      return { type: "icons.read", requestId: "r", ref: id, mimeType: "image/png", data: "UE5H" };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mutations: one request per row, or reading the same PNG twice.
test("rows shown together resolve in one batch and share one read per image", async () => {
  const d = daemon();
  const cache = new ToolIconCache(d);
  let changes = 0;
  cache.subscribe(() => changes++);
  for (const icon of [github, mdn, nothing, github]) cache.load(icon);
  expect(cache.image(github)).toBeUndefined();
  await settle();
  expect(d.calls).toEqual(["resolve:3", "read:a"]);
  expect(cache.image(github)).toBe("data:image/png;base64,UE5H");
  expect(cache.image(mdn)).toBe("data:image/png;base64,UE5H");
  expect(cache.image(nothing)).toBeNull();
  expect(changes).toBeGreaterThan(0);
  cache.load(github);
  await settle();
  expect(d.calls).toHaveLength(2);
});

test("a step that already carries its icon's hash skips resolving", async () => {
  const d = daemon();
  const cache = new ToolIconCache(d);
  cache.load(github, ref("b"));
  await settle();
  expect(d.calls).toEqual(["read:b"]);
  expect(cache.image(github)).toMatch(/^data:image\/png/);
});

// Mutation: caching a failed answer as "no icon" for the session.
test("an unanswered batch is asked again the next time a row shows the icon", async () => {
  const d = daemon();
  d.state.offline = true;
  const cache = new ToolIconCache(d);
  cache.load(github);
  await settle();
  expect(cache.image(github)).toBeUndefined();
  d.state.offline = false;
  cache.load(github);
  await settle();
  expect(cache.image(github)).toMatch(/^data:image\/png/);
});
