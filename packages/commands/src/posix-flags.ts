import { constants } from "node:fs";

const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
/** A directory, never through a link, not inherited by child processes. */
export const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
/** A file to read, never through a link; a FIFO opens without waiting for a writer. */
export const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
