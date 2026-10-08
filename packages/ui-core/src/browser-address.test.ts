import { describe, expect, test } from "vitest";
import {
  addressHost,
  canStep,
  describeBrowserFailure,
  displayAddress,
  emptyHistory,
  parseAddress,
  stepHistory,
  suggestAddresses,
  visitPage,
} from "./browser-address.ts";

describe("typed addresses", () => {
  test("local dev servers open over http and public hosts over https", () => {
    expect(parseAddress("localhost:5173/settings")).toEqual({
      ok: true,
      url: "http://localhost:5173/settings",
    });
    expect(parseAddress("192.168.1.20:8080")).toEqual({
      ok: true,
      url: "http://192.168.1.20:8080/",
    });
    expect(parseAddress("app.localhost")).toEqual({ ok: true, url: "http://app.localhost/" });
    expect(parseAddress("example.com/docs?q=1")).toEqual({
      ok: true,
      url: "https://example.com/docs?q=1",
    });
  });

  test("an explicit http(s) address is kept as typed", () => {
    expect(parseAddress("  http://example.com/a  ")).toEqual({
      ok: true,
      url: "http://example.com/a",
    });
    expect(parseAddress("about:blank")).toEqual({ ok: true, url: "about:blank" });
  });

  test("text that is not an address is refused instead of searched", () => {
    expect(parseAddress("")).toEqual({ ok: false, reason: "empty" });
    expect(parseAddress("how do I center a div")).toEqual({ ok: false, reason: "not_address" });
    expect(parseAddress("readme")).toEqual({ ok: false, reason: "not_address" });
  });

  test("other schemes never reach the page", () => {
    expect(parseAddress("javascript:alert(1)")).toEqual({ ok: false, reason: "scheme" });
    expect(parseAddress("file:///etc/passwd")).toEqual({ ok: false, reason: "scheme" });
    expect(parseAddress("chrome://settings")).toEqual({ ok: false, reason: "scheme" });
  });

  test("the bar shows a page without its scheme or a lone slash", () => {
    expect(displayAddress("http://localhost:5173/")).toBe("localhost:5173");
    expect(displayAddress("https://example.com/a?b=1#c")).toBe("example.com/a?b=1#c");
    expect(displayAddress("about:blank")).toBe("");
    expect(addressHost("localhost:5173/settings")).toBe("localhost:5173");
    expect(addressHost("https://example.com/a")).toBe("example.com");
  });
});

describe("a tab's page history", () => {
  test("Back and Forward walk the pages shown, and a new page drops the forward ones", () => {
    let history = visitPage(emptyHistory, "http://localhost:3000/");
    history = visitPage(history, "http://localhost:3000/a");
    history = visitPage(history, "http://localhost:3000/b");
    expect(canStep(history, 1)).toBe(false);
    history = stepHistory(history, -1);
    history = stepHistory(history, -1);
    expect(history.entries[history.index]).toBe("http://localhost:3000/");
    expect(canStep(history, -1)).toBe(false);
    history = visitPage(history, "http://localhost:3000/c");
    expect(history.entries).toEqual(["http://localhost:3000/", "http://localhost:3000/c"]);
    expect(canStep(history, 1)).toBe(false);
  });

  test("the same page twice is one entry, and history stays bounded", () => {
    let history = visitPage(emptyHistory, "http://localhost:3000/");
    history = visitPage(history, "localhost:3000");
    expect(history.entries).toHaveLength(1);
    for (let page = 0; page < 80; page++) history = visitPage(history, `https://x.dev/${page}`, 50);
    expect(history.entries).toHaveLength(50);
    expect(history.entries.at(-1)).toBe("https://x.dev/79");
  });
});

test("suggestions put addresses that start with the typed text first", () => {
  const known = [
    { url: "https://docs.example.com/", label: "docs.example.com", detail: "Visited" },
    { url: "http://localhost:5173/", label: "web", detail: "Dev server" },
    { url: "http://localhost:5173", label: "web", detail: "Visited" },
    { url: "http://localhost:6006/", label: "storybook", detail: "Dev server" },
  ];
  expect(suggestAddresses("local", known).map((each) => each.label)).toEqual(["web", "storybook"]);
  expect(suggestAddresses("story", known).map((each) => each.label)).toEqual(["storybook"]);
  expect(suggestAddresses("", known, 2)).toHaveLength(2);
});

test("browser failures read as what happened and what to do", () => {
  expect(
    describeBrowserFailure(
      "net::ERR_CONNECTION_REFUSED at http://localhost:4321/",
      "http://localhost:4321/",
    ),
  ).toEqual({
    title: "This site can't be reached",
    detail: "localhost:4321 refused to connect. Is its server running?",
    code: "ERR_CONNECTION_REFUSED",
  });
  expect(describeBrowserFailure("net::ERR_SSL_PROTOCOL_ERROR", "https://x.dev/").code).toBe(
    "ERR_SSL_PROTOCOL_ERROR",
  );
  expect(describeBrowserFailure("Browser controller mismatch", "https://x.dev/").needsControl).toBe(
    true,
  );
  expect(describeBrowserFailure("Browser origin requires approval", "https://x.dev/a").detail).toBe(
    "ace's browser opens x.dev only once it's approved for this thread.",
  );
  expect(describeBrowserFailure("Something odd", "https://x.dev/").detail).toBe(
    "Check the address and connection, then reload the page.",
  );
});
