/**
 * Test child for stalled-folders.process.test.ts: a call blocks on a FIFO with no writer, the way
 * a dead mount blocks, and reaches its deadline. The blocked call is never released; the
 * process must still exit once its own work is done. argv[2] is the folder holding `stuck`.
 */
import { constants } from "node:fs";
import {
  closeCommandFd,
  openCommandChild,
  openResolvedDirectory,
  useCommandCallDeadline,
} from "./posix.ts";

const folder = process.argv[2] ?? "";
useCommandCallDeadline(200);
const root = await openResolvedDirectory(openCommandChild, folder);
try {
  await openCommandChild(root, "stuck", constants.O_RDONLY);
  process.stdout.write("opened\n");
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : "failed"}\n`);
} finally {
  // Waits for the stuck call, which never returns; the process must exit regardless.
  void closeCommandFd(root);
}
