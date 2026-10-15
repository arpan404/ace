// Test boundary: opening one transcript exhausts the worker heap, like a record that
// decodes far beyond its size. Every other path reads normally.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
const poison = z.string().parse(process.env.ACE_TEST_POISON);
const open = fs.open;
fs.open = async (path, flags, mode) => {
  if (String(path) === poison) {
    const hog: number[][] = [];
    for (;;) hog.push(Array.from({ length: 1 << 20 }, () => hog.length + 0.5));
  }
  return open(path, flags, mode);
};
syncBuiltinESMExports();
