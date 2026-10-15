import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { installFatalLogFlush } from "../fatal-log.ts";
import { sqliteFailureDetails } from "../sqlite-failure.ts";

// Buffers lines that no timer will ever flush, then dies of an uncaught error.
const [directory, failure] = z
  .tuple([z.string().min(1), z.enum(["plain", "disk-full"]).optional()])
  .parse(process.argv.slice(2));
const sink = await createFileSink({ directory, totalBytes: 1024 * 1024, context: {} });
const log = createLogger({ sink, now: () => 1, redact: (line) => line, flushMs: 60_000 });
installFatalLogFlush(process, log, (error) => sqliteFailureDetails(error, directory));
log.log("info", "buffered before crash");
setTimeout(() => {
  if (failure !== "disk-full") throw new Error("simulated daemon crash");
  // A real SQLITE_FULL: the database may not grow past one page.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(x)");
  db.exec("PRAGMA max_page_count=2");
  for (;;) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(4096));
}, 0);
