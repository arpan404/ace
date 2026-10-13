import { expect, test } from "vitest";
import { newFolder, newFolderBase, parseFolderQuery, pathInput, upInput } from "./folder-search.ts";
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

test("a typed path names the folder to create, ~ expanded, and a bare name goes in the base", () => {
  const typed = (text: string, base?: string) =>
    newFolder(parseFolderQuery(text, home, home), base);
  expect(typed("~/code/kite")).toEqual({ path: `${home}/code/kite`, name: "kite" });
  expect(typed("/srv/sites/new/")).toEqual({ path: "/srv/sites/new", name: "new" });
  expect(typed("sketch", `${home}/code`)).toEqual({ path: `${home}/code/sketch`, name: "sketch" });
  expect(typed("sketch")).toBeUndefined();
  expect(typed("a/b", `${home}/code`)).toBeUndefined();
  expect(typed("/")).toBeUndefined();
  expect(typed("~/code/bad.")).toBeUndefined();
});

test("a bare name is created beside the latest project only when that place is allowed", () => {
  const roots = [home];
  expect(newFolderBase([`${home}/code/weather`, "/srv/api"], roots, home)).toBe(`${home}/code`);
  expect(newFolderBase(["/srv/api", `${home}/code/weather`], roots, home)).toBe(home);
  expect(newFolderBase([], roots, home)).toBe(home);
  expect(newFolderBase([home], roots, home)).toBe(home);
});
