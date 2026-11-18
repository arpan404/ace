import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { filesSizeLimit } from "../src/ace-files.ts";
import { mediaSizeLimit } from "../src/ace-media.ts";

/** Each staged native's ceiling, by executable name; a release fails when one grows past it. */
const sizeLimits: Record<string, number> = {
  "ace-media": mediaSizeLimit,
  "ace-files": filesSizeLimit,
};
const path = process.argv[2];
if (!path) throw new Error("Usage: size PATH_TO_PACKAGED_ACE_MEDIA_OR_ACE_FILES");
const name = basename(resolve(path)).replace(/\.exe$/, "");
const limit = sizeLimits[name];
if (limit === undefined) throw new Error(`${name} is not a packaged native ace ships`);
const bytes = (await stat(resolve(path))).size;
console.log(`${name}: ${bytes} / ${limit} bytes`);
if (bytes > limit) process.exitCode = 1;
