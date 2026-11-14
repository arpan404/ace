import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { mediaSizeLimit } from "../src/ace-media.ts";
const binary = process.argv[2];
if (!binary) throw new Error("Usage: size PATH_TO_PACKAGED_ACE_MEDIA");
const bytes = (await stat(resolve(binary))).size;
console.log(`ace-media: ${bytes} / ${mediaSizeLimit} bytes`);
if (bytes > mediaSizeLimit) process.exitCode = 1;
