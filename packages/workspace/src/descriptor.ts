import { close, fstat, read, write, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { getSystemErrorName } from "node:util";
import { z } from "zod";
import { DIRECTORY_CAP, WorkspaceError } from "./types.ts";

const require = createRequire(import.meta.url);
const binding = z
  .object({
    pipe: z.function({
      input: [],
      output: z.object({
        read: z.number().int().nonnegative(),
        write: z.number().int().nonnegative(),
      }),
    }),
    openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
    openAt: z.function({
      input: [z.number().int(), z.string(), z.number().int()],
      output: z.number().int().nonnegative(),
    }),
    mkdirAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    statAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.object({
        dev: z.number(),
        ino: z.number(),
        mode: z.number().int(),
        size: z.number(),
        mtime: z.number(),
      }),
    }),
    names: z.function({
      input: [z.number().int(), z.number().int()],
      output: z.array(z.string()).max(DIRECTORY_CAP),
    }),
  })
  .parse(require("../dist/descriptor.node"));
function nativeFailure(error: unknown): never {
  if (error instanceof Error && "errno" in error && typeof error.errno === "number") {
    const code = getSystemErrorName(error.errno);
    if (code === "E2BIG")
      throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
    Object.assign(error, { code });
  }
  throw error;
}
export function openAt(parent: number, name: string, flags: number): Descriptor {
  try {
    return new Descriptor(binding.openAt(parent, name, flags));
  } catch (error) {
    return nativeFailure(error);
  }
}
export function mkdirAt(parent: number, name: string): void {
  try {
    binding.mkdirAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function descriptorNames(fd: number, limit = DIRECTORY_CAP): string[] {
  try {
    return binding.names(fd, limit).toSorted();
  } catch (error) {
    return nativeFailure(error);
  }
}
/** Own a descriptor acquired by openat. Node's callback API accepts it directly. */
export class Descriptor {
  readonly fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  stat(): Promise<Stats> {
    return new Promise((resolve, reject) =>
      fstat(this.fd, (error, info) => (error ? reject(error) : resolve(info))),
    );
  }
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return new Promise((resolve, reject) =>
      read(this.fd, buffer, offset, length, position, (error, bytesRead) =>
        error ? reject(error) : resolve({ bytesRead }),
      ),
    );
  }
  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      close(this.fd, (error) => (error ? reject(error) : resolve())),
    );
  }
  async write(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const count = await new Promise<number>((resolve, reject) =>
        write(this.fd, bytes, offset, bytes.length - offset, offset, (error, written) =>
          error ? reject(error) : resolve(written),
        ),
      );
      if (!count) throw new Error("Short descriptor write");
      offset += count;
    }
  }
}

export function statAt(parent: number, name: string) {
  try {
    return binding.statAt(parent, name);
  } catch (error) {
    return nativeFailure(error);
  }
}

export function openRoot(path: string): Descriptor {
  try {
    return new Descriptor(binding.openRoot(path));
  } catch (error) {
    return nativeFailure(error);
  }
}

export function pipeDescriptors() {
  try {
    return binding.pipe();
  } catch (error) {
    return nativeFailure(error);
  }
}
