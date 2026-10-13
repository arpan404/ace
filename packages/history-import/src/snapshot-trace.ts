// Test-only preload: record each private provider-database snapshot a worker stages.
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
const log = z.string().min(1).parse(process.env.ACE_TEST_SNAPSHOT_LOG);
fs.mkdtemp = new Proxy(fs.mkdtemp, {
  apply(target, receiver, args) {
    if (basename(String(args[0])).startsWith("sqlite-read-"))
      appendFileSync(log, String(args[0]) + "\n");
    return Reflect.apply(target, receiver, args);
  },
});
syncBuiltinESMExports();
