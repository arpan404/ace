import { z } from "zod";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { installFatalLogFlush } from "../fatal-log.ts";

// Buffers lines that no timer will ever flush, then dies of an uncaught error.
const [directory] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
const sink = await createFileSink({ directory, totalBytes: 1024 * 1024, context: {} });
const log = createLogger({ sink, now: () => 1, redact: (line) => line, flushMs: 60_000 });
installFatalLogFlush(process, log);
log.log("info", "buffered before crash");
setTimeout(() => {
  throw new Error("simulated daemon crash");
}, 0);
