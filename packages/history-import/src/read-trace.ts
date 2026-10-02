// Test-only preload: observe real FileHandle reads in an injected worker, without replacing I/O.
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
const log = z.string().min(1).parse(process.env.ACE_TEST_READ_LOG);
const open = fs.open;
fs.open = async (path, flags, mode) => {
  const file = await open(path, flags, mode);
  if (String(path).endsWith(".jsonl"))
    file.read = new Proxy(file.read, {
      apply(target, receiver, args) {
        appendFileSync(log, JSON.stringify({ path: String(path), bytesRequested: args[2] }) + "\n");
        return Reflect.apply(target, receiver, args);
      },
    });
  return file;
};
syncBuiltinESMExports();
