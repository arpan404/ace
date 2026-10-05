import { expect, test } from "vitest";
import { parseFolderQuery, pathInput, upInput } from "./folder-search.ts";
import { freeName } from "./projects.ts";

const home = "/Users/dev";

test("/, ~ and ./ switch to browsing a path; anything else searches", () => {
  expect(parseFolderQuery(" relay ", home, home)).toEqual({ kind: "search", text: "relay" });
  expect(parseFolderQuery("/srv/ww", home, home)).toEqual({
    kind: "path",
    directory: "/srv",
    segment: "ww",
  });
  expect(parseFolderQuery("~", home, home)).toEqual({ kind: "path", directory: home, segment: "" });
  expect(parseFolderQuery("~/Code/", home, home)).toEqual({
    kind: "path",
    directory: `${home}/Code`,
    segment: "",
  });
  expect(parseFolderQuery("./Code/de", home, `${home}/x`)).toEqual({
    kind: "path",
    directory: `${home}/x/Code`,
    segment: "de",
  });
  expect(parseFolderQuery("../", home, `${home}/x`)).toEqual({
    kind: "path",
    directory: home,
    segment: "",
  });
});

test("a path that needs the home folder stays a search until the home is known", () => {
  expect(parseFolderQuery("~/Code", undefined, undefined)).toEqual({
    kind: "search",
    text: "~/Code",
  });
});

test("a browsed folder is written back under ~ when it is inside home", () => {
  expect(pathInput(`${home}/Code`, home)).toBe("~/Code/");
  expect(pathInput("/srv/www", home)).toBe("/srv/www/");
  expect(pathInput("/", home)).toBe("/");
});

test("going up drops the typed segment first, then one folder, and stops at a root", () => {
  expect(upInput({ kind: "path", directory: `${home}/Code`, segment: "de" }, home)).toBe("~/Code/");
  expect(upInput({ kind: "path", directory: `${home}/Code`, segment: "" }, home)).toBe("~/");
  expect(upInput({ kind: "path", directory: home, segment: "" }, home, [home])).toBeUndefined();
  expect(upInput({ kind: "path", directory: "/", segment: "" }, home)).toBeUndefined();
});

test("a taken folder name suggests the next free one, ignoring case", () => {
  expect(freeName("web", ["Web", "web-2"])).toBe("web-3");
  expect(freeName("api", ["web"])).toBe("api");
});
