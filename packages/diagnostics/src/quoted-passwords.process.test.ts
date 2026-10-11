import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { temporary, controlledWorker } from "./test-support.ts";

it.each([false, true])(
  "saved diagnostics omit a whole quoted password with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const logger = createLogger({
      sink: await createFileSink(
        { directory, fileBytes: 4096, totalBytes: 8192, context: {} },
        worker ? controlledWorker : undefined,
      ),
      now: () => 0,
      redact: createRedactor({}),
    });
    logger.log("warn", 'request failed: password="first private, second; private" after');
    await logger.close();
    const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
    expect(saved).not.toContain("private");
    expect(JSON.parse(saved).message).toBe("request failed: <SECRET> after");
  },
);
