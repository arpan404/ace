import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface DaemonLogRecord {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}
/** Every record in `ACE_HOME/logs`, oldest file first. */
export async function daemonLogRecords(home: string): Promise<DaemonLogRecord[]> {
  const directory = join(home, "logs");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).toSorted();
  const texts = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
  return texts
    .flatMap((text) => text.split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as DaemonLogRecord);
}
