/**
 * Which reads the native store serves (ADR 0222 phases 1b to 3): `ACE_STORE_READS`, a comma
 * list of `items`, `long` and `sidebar`, read once at the process's I/O boundary. Native reads
 * run on the native connection, so they need `ACE_STORE=native`; asking for them without it
 * fails at startup rather than silently reading through TypeScript.
 */
export type NativeReadKind = "items" | "long" | "sidebar";
const kinds: readonly NativeReadKind[] = ["items", "long", "sidebar"];

function parse(value: string | undefined, native: boolean): ReadonlySet<NativeReadKind> {
  const asked = new Set<NativeReadKind>();
  for (const part of (value ?? "").split(",")) {
    const name = part.trim();
    if (!name) continue;
    const kind = kinds.find((candidate) => candidate === name);
    if (!kind) throw new Error(`ACE_STORE_READS names an unknown read: ${name}`);
    asked.add(kind);
  }
  if (asked.size && !native) throw new Error("ACE_STORE_READS needs ACE_STORE=native");
  return asked;
}

const enabled = parse(process.env.ACE_STORE_READS, process.env.ACE_STORE === "native");

/** Whether the native store serves this kind of read in this process. */
export function nativeReads(kind: NativeReadKind): boolean {
  return enabled.has(kind);
}
