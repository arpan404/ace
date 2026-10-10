// Test boundary: append to a real transcript after its inventory stat or sample read.
import fs from "node:fs/promises";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
const input = z
  .object({ path: z.string(), marker: z.string(), mode: z.enum(["stat", "read"]) })
  .parse(JSON.parse(process.env.ACE_TEST_SAMPLE_RACE ?? "{}"));
const append = () => {
  if (!existsSync(input.marker)) return;
  unlinkSync(input.marker);
  appendFileSync(
    input.path,
    JSON.stringify({ type: "ai-title", sessionId: "live", aiTitle: "after race" }) + "\n",
  );
};
const lstat = fs.lstat;
fs.lstat = async (path, options) => {
  const result = await lstat(path, options);
  if (String(path) === input.path && input.mode === "stat") append();
  return result;
};
const open = fs.open;
fs.open = async (path, flags, mode) => {
  const file = await open(path, flags, mode);
  if (String(path) === input.path && input.mode === "read") {
    file.read = new Proxy(file.read, {
      async apply(target, receiver, args) {
        const result = await Reflect.apply(target, receiver, args);
        append();
        return result;
      },
    });
  }
  return file;
};
syncBuiltinESMExports();
