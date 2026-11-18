import { stat } from "node:fs/promises";
import { hashFile } from "@ace/service";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { mediaSizeLimit, stagedAceMedia } from "./ace-media.ts";
import { runShipped } from "./native-smoke.ts";
import { checkLinuxRustBinary } from "./rust-binary.ts";

type Target = z.infer<typeof ReleaseTarget>;

/** Run the stub using the shipped daemon runtime, from the shipped layout, with no source imports. */
export async function smokeMedia(root: string, target: Target, version: string, runtime: string) {
  const binary = stagedAceMedia(root, target);
  if ((await stat(binary)).size > mediaSizeLimit) throw new Error("ace-media exceeds 8 MB");
  const output = runShipped(runtime, [
    "-e",
    `const {execFileSync}=require('node:child_process');const p=${JSON.stringify(binary)};if(execFileSync(p,['--version'],{encoding:'utf8',timeout:10000}).trim()!==${JSON.stringify(version)})throw Error('ace-media version mismatch');execFileSync(p,[],{timeout:10000,stdio:'pipe'});`,
  ]);
  if (output.trim()) throw new Error("Unexpected media smoke output");
  if (target.startsWith("linux-")) await checkLinuxRustBinary("ace-media", binary);
  process.stdout.write(
    `ace-media ${target}: packaged version and clean exit passed (${await hashFile(binary)})\n`,
  );
}
