import { describe, expect, test } from "vitest";
import { linkDestination } from "./web-links.ts";

const plain = { button: 0, metaKey: false, ctrlKey: false };
const cmd = { ...plain, metaKey: true };
const ctrl = { ...plain, ctrlKey: true };
const middle = { ...plain, button: 1 };
const github = "https://github.com/acme/ace/pull/12";

describe("where a followed link opens", () => {
  test("a plain click opens ace's browser when the screen has one", () => {
    expect(linkDestination({ url: github, click: plain, apple: true, inApp: true })).toBe("app");
    expect(linkDestination({ url: github, click: undefined, apple: false, inApp: true })).toBe(
      "app",
    );
  });

  test("⌘-click on a Mac and Ctrl-click elsewhere open the system's browser", () => {
    expect(linkDestination({ url: github, click: cmd, apple: true, inApp: true })).toBe("system");
    expect(linkDestination({ url: github, click: ctrl, apple: false, inApp: true })).toBe("system");
  });

  test("the other platform's modifier is a plain click", () => {
    expect(linkDestination({ url: github, click: ctrl, apple: true, inApp: true })).toBe("app");
    expect(linkDestination({ url: github, click: cmd, apple: false, inApp: true })).toBe("app");
  });

  test("a middle click opens the system's browser", () => {
    expect(linkDestination({ url: github, click: middle, apple: true, inApp: true })).toBe(
      "system",
    );
  });

  test("a local address opens in the system's browser with ⌘, Ctrl or a middle click", () => {
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000", "http://[::1]:8080/"]) {
      expect(linkDestination({ url, click: cmd, apple: true, inApp: true })).toBe("system");
      expect(linkDestination({ url, click: ctrl, apple: false, inApp: true })).toBe("system");
      expect(linkDestination({ url, click: middle, apple: true, inApp: true })).toBe("system");
      expect(linkDestination({ url, click: plain, apple: true, inApp: true })).toBe("app");
    }
  });

  test("a screen without ace's browser opens every address in the system's browser", () => {
    expect(linkDestination({ url: github, click: plain, apple: true, inApp: false })).toBe(
      "system",
    );
    expect(
      linkDestination({ url: "http://localhost:3000", click: plain, apple: true, inApp: false }),
    ).toBe("system");
  });
});
