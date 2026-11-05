// Test boundary: reading one transcript makes the reader's memory grow past its limit, like a
// record that decodes far beyond its size. It is recognised by its content (JSON.parse is a
// global every runtime lets a preload wrap), so every other file reads normally.
import { z } from "zod";
const marker = z.string().min(1).parse(process.env.ACE_TEST_POISON_MARKER);
const target = z.coerce.number().positive().parse(process.env.ACE_TEST_POISON_BYTES);
const parse = JSON.parse;
JSON.parse = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
  if (typeof text === "string" && text.includes(marker)) {
    const hog: number[][] = [];
    while (process.memoryUsage().rss < target)
      for (let i = 0; i < 16; i++) hog.push(Array.from({ length: 1 << 16 }, (_, n) => n + 0.5));
    // Grown no further, so a watchdog that failed couldn't take the machine with it: the
    // reader just stops answering until something kills it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return parse(text, reviver);
};
