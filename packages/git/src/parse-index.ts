import { z } from "zod";
import { decode, hashSchema, malformed, modeSchema, nul, pathSchema } from "./decode.ts";

const indexSchema = z.tuple([
  modeSchema.exclude(["000000"]),
  hashSchema,
  z.enum(["0", "1", "2", "3"]),
]);
const treeSchema = z.tuple([modeSchema, z.enum(["blob", "tree", "commit"]), hashSchema]);
export interface IndexEntry {
  mode: string;
  sha: string;
  stage: string;
  path: string;
}
export function parseIndex(buffer: Buffer): IndexEntry[] {
  return nul(buffer).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = decode(
      indexSchema,
      tab < 0 ? null : record.slice(0, tab).split(" "),
      "index record",
    );
    const path = decode(pathSchema, record.slice(tab + 1), "index path");
    return { mode, sha, stage, path };
  });
}
export function parseTree(
  buffer: Buffer,
): { mode: string; type: string; sha: string; path: string }[] {
  return nul(buffer).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, sha] = decode(
      treeSchema,
      tab < 0 ? null : record.slice(0, tab).split(" "),
      "tree record",
    );
    if (
      (mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob") !== type ||
      mode === "000000"
    )
      throw malformed("tree mode/type");
    return { mode, type, sha, path: decode(pathSchema, record.slice(tab + 1), "tree path") };
  });
}
