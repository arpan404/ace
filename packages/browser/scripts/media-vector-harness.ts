import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export type Vectors = Record<string, unknown>;
const root = new URL("../../../native/media/vectors/", import.meta.url);
export function writeVectors(vectors: Vectors): void {
  for (const [area, value] of Object.entries(vectors)) {
    const directory = new URL(`${area}/`, root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new URL("scenarios.json", directory),
      JSON.stringify(jsonValue(value), null, 2) + "\n",
    );
  }
}
export function committedVectors(area: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${area}/scenarios.json`, root)), "utf8"));
}
/** Canonical JSON representation also normalizes optional properties and typed arrays. */
export function jsonValue(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Uint8Array) return { hex: Buffer.from(item).toString("hex") };
      if (item instanceof Map) return Array.from(item.entries());
      return item;
    }),
  );
}
