import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
export async function readBoundedJson(path: string, maximum: number): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size > maximum) throw new Error("JSON file exceeds byte budget");
    const buffer = Buffer.alloc(Math.min(maximum + 1, size + 1));
    let bytes = 0;
    for (;;) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      bytes += result.bytesRead;
      if (bytes > size) throw new Error("JSON file changed while reading");
      if (!result.bytesRead) break;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
  } finally {
    await file.close();
  }
}
/** Rename published the value; callers must not delete artifacts referenced by it. */
export class CommittedWriteError extends Error {
  constructor(cause: unknown) {
    super("Published inventory durability could not be confirmed", { cause });
  }
}
export type AtomicFileRuntime = { syncDirectory?: (directory: string) => Promise<void> };
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export function atomicJsonFile(
  path: string,
  maximum: number,
  id: () => string,
  runtime: AtomicFileRuntime = {},
) {
  return {
    async load(): Promise<unknown> {
      try {
        return await readBoundedJson(path, maximum);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(value: unknown): Promise<void> {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > maximum) throw new Error("JSON file exceeds byte budget");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${id()}.tmp`;
      let committed = false;
      let failure: { error: unknown } | undefined;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(json);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        committed = true;
        try {
          await (runtime.syncDirectory ?? syncDirectory)(dirname(path));
        } catch (error) {
          throw new CommittedWriteError(error);
        }
      } catch (error) {
        failure = { error };
      }
      try {
        await rm(temporary, { force: true });
      } catch (error) {
        failure ??= { error };
      }
      if (failure) {
        if (committed && !(failure.error instanceof CommittedWriteError))
          throw new CommittedWriteError(failure.error);
        throw failure.error;
      }
    },
  };
}
