// Test-only preload: observe real FileHandle reads in an injected worker, without replacing I/O.
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
const log = z.string().min(1).parse(process.env.ACE_TEST_READ_LOG);
const record = (path: unknown, api: string) => {
  if (String(path).endsWith(".jsonl"))
    appendFileSync(log, JSON.stringify({ path: String(path), api }) + "\n");
};
fs.readFile = new Proxy(fs.readFile, {
  apply(target, receiver, args) {
    record(args[0], "fs.promises.readFile");
    return Reflect.apply(target, receiver, args);
  },
});
nativeFs.readFile = new Proxy(nativeFs.readFile, {
  apply(target, receiver, args) {
    record(args[0], "fs.readFile");
    return Reflect.apply(target, receiver, args);
  },
});
nativeFs.createReadStream = new Proxy(nativeFs.createReadStream, {
  apply(target, receiver, args) {
    record(args[0], "fs.createReadStream");
    return Reflect.apply(target, receiver, args);
  },
});
const open = fs.open;
fs.open = async (path, flags, mode) => {
  const file = await open(path, flags, mode);
  if (String(path).endsWith(".jsonl")) {
    file.read = new Proxy(file.read, {
      apply(target, receiver, args) {
        record(path, "FileHandle.read");
        return Reflect.apply(target, receiver, args);
      },
    });
    file.readFile = new Proxy(file.readFile, {
      apply(target, receiver, args) {
        record(path, "FileHandle.readFile");
        return Reflect.apply(target, receiver, args);
      },
    });
    file.createReadStream = new Proxy(file.createReadStream, {
      apply(target, receiver, args) {
        record(path, "FileHandle.createReadStream");
        return Reflect.apply(target, receiver, args);
      },
    });
  }
  return file;
};
syncBuiltinESMExports();
