import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireChromium } from "../src/acquisition.ts";

// CI only: install ace's pinned Chrome for Testing the way first use does, and point the
// browser suites at it for the rest of the job.
const env = z
  .object({ GITHUB_ENV: z.string().min(1), RUNNER_TEMP: z.string().min(1) })
  .parse(process.env);
const executable = await acquireChromium({ dataDir: join(env.RUNNER_TEMP, "ace-chrome") });
await appendFile(env.GITHUB_ENV, `ACE_CHROMIUM_PATH=${executable}\n`);
console.log(executable);
