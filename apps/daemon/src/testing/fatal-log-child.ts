import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { installFatalLogFlush, installRejectionGuard } from "../fatal-log.ts";
import { isStoreRetry } from "../store-busy.ts";
import { sqliteFailureDetails } from "../sqlite-failure.ts";

// Buffers lines that no timer will ever flush, then dies of an uncaught error.
const [directory, failure] = z
  .tuple([
    z.string().min(1),
    z
      .enum(["plain", "disk-full", "busy-rejection", "plain-rejection", "disk-full-rejection"])
      .optional(),
  ])
  .parse(process.argv.slice(2));
const sink = await createFileSink({ directory, totalBytes: 1024 * 1024, context: {} });
const log = createLogger({ sink, now: () => 1, redact: (line) => line, flushMs: 60_000 });
installFatalLogFlush(process, log, (error) => sqliteFailureDetails(error, directory));
installRejectionGuard(process, log, isStoreRetry, Date.now);
log.log("info", "buffered before crash");
/** A real SQLITE_FULL: the database may not grow past two pages. */
function fill(): never {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(x)");
  db.exec("PRAGMA max_page_count=2");
  for (;;) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(4096));
}
const rejected = () => {
  if (failure === "busy-rejection") return new Error("Store is busy");
  if (failure !== "disk-full-rejection") return new Error("simulated daemon crash");
  try {
    fill();
  } catch (error) {
    return error;
  }
};
if (failure?.endsWith("-rejection")) {
  // A timer chain that never catches, like a periodic sweep whose first write finds the store busy.
  setTimeout(() => {
    void Promise.reject(rejected()).finally(() => {});
  }, 0);
  setTimeout(() => {
    log.log("info", "still running");
    log.flushSync();
    process.exit(0);
  }, 50);
} else
  setTimeout(() => {
    if (failure !== "disk-full") throw new Error("simulated daemon crash");
    fill();
  }, 0);
