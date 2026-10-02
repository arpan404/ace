import {
  PtyBytesSchema,
  PtyExitSchema,
  TerminalProcessSchema,
  PosixSessionsSchema,
} from "@ace/protocol";
import type { ExitStatus } from "./types.ts";

export function decodeExit(input: unknown): ExitStatus {
  const event = PtyExitSchema.parse(input);
  return { code: event.exitCode, signal: event.signal || null };
}

export function decodeBytes(input: unknown): Buffer {
  const bytes = PtyBytesSchema.parse(input);
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Only typed identity fields leave the process-table parser. */
export function decodeProcesses(input: string) {
  return input
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) throw new Error("Malformed POSIX process table row");
      return TerminalProcessSchema.parse({
        pid: Number(match[1]),
        group: Number(match[2]),
        state: match[3],
        owner: null,
      });
    });
}
export type ProcessIdentity = ReturnType<typeof decodeProcesses>[number];

export function decodeSessionColumns(input: string) {
  return PosixSessionsSchema.parse(
    input
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        return { pid: Number(fields[0]), session: Number(fields[3]) };
      }),
  );
}

export function decodeNativeSessions(input: string) {
  const value: unknown = JSON.parse(input);
  return PosixSessionsSchema.parse(value);
}
