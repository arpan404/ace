import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { findExecutable } from "@ace/provider-kit/discovery";

export interface ModelImageRuntime {
  encoder(): Promise<string | undefined>;
  spawn(command: string, args: string[]): ChildProcessWithoutNullStreams;
  after(milliseconds: number, expire: () => void): () => void;
}
/** The sole system boundary. Tests supply discovery, child processes and deadlines. */
export const systemModelImageRuntime: ModelImageRuntime = {
  encoder: () => findExecutable("ffmpeg", process.env),
  spawn: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }),
  after(milliseconds, expire) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
};
