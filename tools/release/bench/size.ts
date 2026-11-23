import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { filesSizeLimit } from "../src/ace-files.ts";
import { historySizeLimit } from "../src/ace-history.ts";
import { mediaSizeLimit } from "../src/ace-media.ts";
import { shippedExecutableName } from "@ace/service/process-names";

/**
 * Each staged native's ceiling, by the name it ships as on any platform (`ace Media Service`,
 * `ace-media-service`); a release fails when one grows past it.
 */
const limits = { media: mediaSizeLimit, files: filesSizeLimit, history: historySizeLimit };
const sizeLimits: Record<string, number> = Object.fromEntries(
  (["media", "files", "history"] as const).flatMap((native) =>
    (["darwin", "linux"] as const).map((platform) => [
      shippedExecutableName(native, platform),
      limits[native],
    ]),
  ),
);
const path = process.argv[2];
if (!path) throw new Error("Usage: size PATH_TO_A_PACKAGED_NATIVE (media/ace Media Service, ...)");
const name = basename(resolve(path)).replace(/\.exe$/, "");
const limit = sizeLimits[name];
if (limit === undefined) throw new Error(`${name} is not a packaged native ace ships`);
const bytes = (await stat(resolve(path))).size;
console.log(`${name}: ${bytes} / ${limit} bytes`);
if (bytes > limit) process.exitCode = 1;
