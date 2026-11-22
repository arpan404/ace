/**
 * Folders with a mark of their own, closed and open: source, tests, docs, `.github`, installed
 * modules, scripts and assets. The folder keeps the row's ink; its mark is an accent
 * (`accented`) the app paints in the folder type's tone. Any other folder is the plain one.
 */
import { glyph } from "../glyph.ts";
import { onCircle, polygon, polyline } from "../geometry.ts";
import { accented, detail, dot, type Part } from "../parts.ts";
import { folder } from "./folder-simple.ts";
import { openFolder } from "./folder-open.ts";

/** Source: a pair of angle brackets. */
const sourceMark = (): Part[] => [
  detail(
    polyline([
      [10.25, 12.75],
      [8.25, 15.25, 0.6],
      [10.25, 17.75],
    ]),
  ),
  detail(
    polyline([
      [13.75, 12.75],
      [15.75, 15.25, 0.6],
      [13.75, 17.75],
    ]),
  ),
];

/** Tests: a check. */
const testsMark = (): Part[] => [
  detail(
    polyline([
      [8.75, 15.25],
      [11, 17.5, 0.6],
      [15.25, 13],
    ]),
  ),
];

/** Docs: two lines of text. */
const docsMark = (): Part[] => [detail("M8.5 13.75h7M8.5 17h4.5")];

/** `.github`: a branch, two nodes joined. */
const githubMark = (): Part[] => [
  dot(9, 17.25, 1.25),
  dot(15, 13.25, 1.25),
  detail("M9 13v4M15 13.5c0 2.25-6 1.5-6 3.75"),
];

/** Installed modules: a small box. */
const modulesMark = (): Part[] => [
  detail(polygon([0, 60, 120, 180, 240, 300].map((a) => [...onCircle(12, 15.25, 3, a - 90), 0.8]))),
];

/** Scripts: a prompt. */
const scriptsMark = (): Part[] => [
  detail(
    polyline([
      [8.75, 13],
      [11, 15.25, 0.6],
      [8.75, 17.5],
    ]),
  ),
  detail("M12.75 17.5h3"),
];

/** Assets: a hill under a sun. */
const assetsMark = (): Part[] => [
  dot(14.5, 13, 1.25),
  detail(
    polyline([
      [8, 17.75],
      [11, 14.5, 0.7],
      [14, 17.75],
    ]),
  ),
];

/** The folder, closed or open, with `mark` as its accent. */
const marked = (mark: () => Part[], open: boolean) => () => [
  ...(open ? openFolder() : folder()),
  ...accented(mark()),
];

export const SourceFolderIcon = /* @__PURE__ */ glyph("SourceFolder", marked(sourceMark, false));
export const SourceFolderOpenIcon = /* @__PURE__ */ glyph(
  "SourceFolderOpen",
  marked(sourceMark, true),
);
export const TestsFolderIcon = /* @__PURE__ */ glyph("TestsFolder", marked(testsMark, false));
export const TestsFolderOpenIcon = /* @__PURE__ */ glyph(
  "TestsFolderOpen",
  marked(testsMark, true),
);
export const DocsFolderIcon = /* @__PURE__ */ glyph("DocsFolder", marked(docsMark, false));
export const DocsFolderOpenIcon = /* @__PURE__ */ glyph("DocsFolderOpen", marked(docsMark, true));
export const GithubFolderIcon = /* @__PURE__ */ glyph("GithubFolder", marked(githubMark, false));
export const GithubFolderOpenIcon = /* @__PURE__ */ glyph(
  "GithubFolderOpen",
  marked(githubMark, true),
);
export const ModulesFolderIcon = /* @__PURE__ */ glyph("ModulesFolder", marked(modulesMark, false));
export const ModulesFolderOpenIcon = /* @__PURE__ */ glyph(
  "ModulesFolderOpen",
  marked(modulesMark, true),
);
export const ScriptsFolderIcon = /* @__PURE__ */ glyph("ScriptsFolder", marked(scriptsMark, false));
export const ScriptsFolderOpenIcon = /* @__PURE__ */ glyph(
  "ScriptsFolderOpen",
  marked(scriptsMark, true),
);
export const AssetsFolderIcon = /* @__PURE__ */ glyph("AssetsFolder", marked(assetsMark, false));
export const AssetsFolderOpenIcon = /* @__PURE__ */ glyph(
  "AssetsFolderOpen",
  marked(assetsMark, true),
);
