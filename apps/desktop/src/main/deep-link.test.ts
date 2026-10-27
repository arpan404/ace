import { describe, expect, it } from "vitest";
import { deepLinkRoute } from "../shared/contract.ts";
import { linksFromArgv, parseDeepLink } from "./deep-link.ts";

const route = (input: string) => {
  const link = parseDeepLink(input);
  return link && deepLinkRoute(link);
};

describe("ace:// links", () => {
  it("ignores malformed encoded links without interrupting valid launch arguments", () => {
    for (const input of ["ace://thread/%", "ace://thread/%C0%AF", "ace://new/%E0%A4%A"]) {
      expect(parseDeepLink(input)).toBeUndefined();
    }
    expect(
      linksFromArgv(["ace://thread/%", "ace://thread/caf%C3%A9/item/a%25b"], () => false),
    ).toEqual([{ kind: "thread", threadId: "café", itemId: "a%b" }]);
  });

  it("opens New thread on the folder an ace://open link names", () => {
    expect(route("ace://open?folder=%2FUsers%2Fme%2FCode%2Fapp")).toBe(
      "/new?folder=%2FUsers%2Fme%2FCode%2Fapp",
    );
    expect(route("ace://open?folder=/Users/me/My%20App")).toBe(
      "/new?folder=%2FUsers%2Fme%2FMy%20App",
    );
  });

  it("still understands the older path= spelling", () => {
    expect(route("ace://open?path=/srv/app")).toBe("/new?folder=%2Fsrv%2Fapp");
  });

  it("ignores an open link without an absolute folder", () => {
    expect(parseDeepLink("ace://open")).toBeUndefined();
    expect(parseDeepLink("ace://open?folder=Code/app")).toBeUndefined();
    expect(parseDeepLink("https://open?folder=/srv/app")).toBeUndefined();
  });

  it("turns folders from the dock or Open in ace into folder links, skipping files and flags", () => {
    const folders = new Set(["/Users/me/Code/app"]);
    expect(
      linksFromArgv(
        ["--background", "/Users/me/Code/app", "/Users/me/notes.txt", "ace://new"],
        (path) => folders.has(path),
      ),
    ).toEqual([{ kind: "open-folder", path: "/Users/me/Code/app" }, { kind: "new-thread" }]);
  });

  it("opens a folder a Linux launcher passes as a file URI, but not another machine's", () => {
    const folders = new Set(["/home/me/My Code"]);
    expect(
      linksFromArgv(
        [
          "file:///home/me/My%20Code",
          "file://localhost/home/me/My%20Code",
          "file://server/home/me/My%20Code",
          "file:///home/me/notes.txt",
        ],
        (path) => folders.has(path),
      ),
    ).toEqual([
      { kind: "open-folder", path: "/home/me/My Code" },
      { kind: "open-folder", path: "/home/me/My Code" },
    ]);
  });
});

it("message links keep item ids exactly as the desktop always read them", () => {
  expect(parseDeepLink("ace://thread/t/item/a%2Fb")).toEqual({
    kind: "thread",
    threadId: "t",
    itemId: "a/b",
  });
  expect(parseDeepLink("ace://thread/my%20thread/item/one%20two")).toEqual({
    kind: "thread",
    threadId: "my thread",
    itemId: "one two",
  });
  const long = "x".repeat(300);
  expect(parseDeepLink(`ace://thread/t/item/${long}`)).toEqual({
    kind: "thread",
    threadId: "t",
    itemId: long,
  });
});
