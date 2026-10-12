import { count, decode, malformed, pathSchema, type Records } from "./decode.ts";

/** A NUL-framed numstat record uses only its first two tabs as delimiters. */
export function numstatRecord(record: string, records: Records) {
  const first = record.indexOf("\t");
  const second = record.indexOf("\t", first + 1);
  if (first < 0 || second < 0) throw malformed("numstat arity");
  const added = record.slice(0, first);
  const removed = record.slice(first + 1, second);
  let path = record.slice(second + 1);
  let oldPath = "";
  if (!path) {
    oldPath = decode(pathSchema, records.next(), "numstat source");
    path = records.next();
  }
  path = decode(pathSchema, path, "numstat path");
  const binary = added === "-" && removed === "-";
  return {
    path,
    oldPath,
    additions: binary ? 0 : count(added),
    deletions: binary ? 0 : count(removed),
    binary,
  };
}
