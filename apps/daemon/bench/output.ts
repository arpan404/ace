import { writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { resolve } from "node:path";

/** Keep long raw series lossless without burying the code review in telemetry rows. */
export async function writeMeasurement(output: string, json: string): Promise<void> {
  if (!output) return;
  const data = output.endsWith(".gz") ? await promisify(gzip)(json) : json;
  await writeFile(resolve(output), data);
}
