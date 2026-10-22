import { describe, expect, test } from "vitest";
import { isLocalAddress, linkDestination } from "./web-links.ts";

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

  test("a local address opens in ace's browser even with ⌘ or Ctrl held", () => {
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000", "http://[::1]:8080/"]) {
      expect(linkDestination({ url, click: cmd, apple: true, inApp: true })).toBe("app");
      expect(linkDestination({ url, click: ctrl, apple: false, inApp: true })).toBe("app");
      expect(linkDestination({ url, click: middle, apple: true, inApp: true })).toBe("app");
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

describe("local addresses", () => {
  test.each([
    "http://localhost:3000",
    "http://app.localhost/",
    "http://printer.local/",
    "http://127.0.0.1/",
    "http://127.4.5.6/",
    "http://0.0.0.0:8000/",
    "http://10.0.0.8/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.20:8080/",
    "http://169.254.1.1/",
    "http://[::1]:5173/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
  ])("%s is on this computer or its network", (url) => {
    expect(isLocalAddress(url)).toBe(true);
  });

  test.each([
    "https://github.com/",
    "http://172.32.0.1/",
    "http://11.0.0.1/",
    "http://localhost.example.com/",
    "http://[2001:db8::1]/",
    "mailto:someone@localhost",
    "not a url",
  ])("%s is not", (url) => {
    expect(isLocalAddress(url)).toBe(false);
  });
});
