import { resolve } from "node:path";
import { PreviewLaunchFile } from "@ace/protocol/preview";
import { readBoundedText } from "./bounded-file.ts";

export async function loadLaunchFile(root: string) {
  const file = await readBoundedText(resolve(root, ".ace", "launch.json"));
  return PreviewLaunchFile.parse(JSON.parse(file));
}
