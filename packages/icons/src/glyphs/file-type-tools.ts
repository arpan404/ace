/**
 * The marks of files a project's tools read: packages and crates, lockfiles, containers, build
 * files, Git's own files, configs, READMEs, licences, changelogs, agent instructions, Vite,
 * linters, formatters and tests. Most reuse the set's own drawing of the idea (a key, Buddy, a
 * flask), so a file's mark and the app's icon for the same thing agree. ADR 0156.
 */
import { glyph } from "../glyph.ts";
import { polygon, rect } from "../geometry.ts";
import { circle, detail, line, shape } from "../parts.ts";
import { bookOpen } from "./book-open.ts";
import { clockBack } from "./clock-counter-clockwise.ts";
import { flask } from "./flask.ts";
import { gitBranch } from "./git-branch.ts";
import { hammer } from "./hammer.ts";
import { lightning } from "./lightning.ts";
import { keyhole } from "./lock.ts";
import { lockBody, shackleShut } from "./lock-simple.ts";
import { packageBox } from "./package.ts";
import { buddy } from "./robot.ts";
import { shieldCheck } from "./shield-check.ts";
import { textAlignLeft } from "./text-align-left.ts";

/** A package manifest: a box with tape across its lid. */
export const PackageFileIcon = /* @__PURE__ */ glyph("PackageFile", packageBox);

/** A lockfile: a padlock. */
export const LockFileIcon = /* @__PURE__ */ glyph("LockFile", () => [
  lockBody(),
  shackleShut(),
  keyhole(),
]);

/** A TypeScript project's settings: the square tile with two sliders. */
export const TsconfigFileIcon = /* @__PURE__ */ glyph("TsconfigFile", () => [
  shape(rect(3, 3, 18, 18, 5)),
  detail("M7.25 9h9.5M7.25 15h9.5"),
  detail(circle(10, 9, 1.9)),
  detail(circle(14, 15, 1.9)),
]);

/** A Rust crate's manifest: a wooden crate of staggered planks. */
export const CargoFileIcon = /* @__PURE__ */ glyph("CargoFile", () => [
  shape(rect(3, 4.5, 18, 15, 3)),
  detail("M3.4 12h17.2M9 4.9v6.7M15 12.4v6.7"),
]);

/** Containers: three boxes stacked. */
export const DockerFileIcon = /* @__PURE__ */ glyph("DockerFile", () => [
  shape(rect(2.75, 12.75, 8.25, 7.25, 2)),
  shape(rect(13, 12.75, 8.25, 7.25, 2)),
  shape(rect(7.875, 4, 8.25, 7.25, 2)),
]);

/** Build files: a hammer. */
export const MakeFileIcon = /* @__PURE__ */ glyph("MakeFile", hammer);

/** Git's own files: a branch. */
export const GitFileIcon = /* @__PURE__ */ glyph("GitFile", gitBranch);

/** Editor settings: a sheet of sliders. */
export const EditorconfigFileIcon = /* @__PURE__ */ glyph("EditorconfigFile", () => [
  line("M3.5 7h4.5M12.5 7h8M3.5 17h10M18 17h2.5"),
  line(circle(10.25, 7, 2.25)),
  line(circle(15.75, 17, 2.25)),
  line("M3.5 12h17"),
]);

/** A README: an open book. */
export const ReadmeFileIcon = /* @__PURE__ */ glyph("ReadmeFile", bookOpen);

/** A licence: a medal on its ribbon. */
export const LicenseFileIcon = /* @__PURE__ */ glyph("LicenseFile", () => [
  line(
    polygon([
      [8.25, 14, 0.5],
      [7, 21, 0.8],
      [12, 18.75, 0.8],
      [17, 21, 0.8],
      [15.75, 14, 0.5],
    ]),
  ),
  shape(circle(12, 9.25, 6.5)),
  detail(circle(12, 9.25, 2.5)),
]);

/** A changelog: a clock turning back. */
export const ChangelogFileIcon = /* @__PURE__ */ glyph("ChangelogFile", clockBack);

/** Agent instructions (AGENTS.md and kin): Buddy, ace's agent. */
export const AgentsFileIcon = /* @__PURE__ */ glyph("AgentsFile", buddy);

/** Vite and Vitest settings: a bolt. */
export const ViteFileIcon = /* @__PURE__ */ glyph("ViteFile", lightning);

/** Linter settings: a shield with a check. */
export const LintFileIcon = /* @__PURE__ */ glyph("LintFile", shieldCheck);

/** Formatter settings: lines set flush. */
export const FormatFileIcon = /* @__PURE__ */ glyph("FormatFile", textAlignLeft);

/** Tests: a lab flask. */
export const TestFileIcon = /* @__PURE__ */ glyph("TestFile", flask);
