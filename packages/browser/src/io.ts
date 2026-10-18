import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Replace process boundaries without replacing browser decision logic. */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
export const spawnProcess: ProcessSpawner = spawn;
