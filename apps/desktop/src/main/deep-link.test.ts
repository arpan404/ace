import { describe, expect, it } from "vitest";
import { deepLinkRoute } from "../shared/contract.ts";
import { linksFromArgv, parseDeepLink } from "./deep-link.ts";

const route = (input: string) => {
  const link = parseDeepLink(input);
  return link && deepLinkRoute(link);
};

describe("ace:// links", () => {
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
});
