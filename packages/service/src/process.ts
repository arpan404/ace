import { execFile } from "node:child_process";
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (file: string, args: readonly string[]) => Promise<ProcessResult>;
export const runProcess: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
export async function checked(
  run: Runner,
  file: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await run(file, args);
  if (result.code) throw new Error(`${file} failed (${result.code}): ${result.stderr}`);
  return result;
}
