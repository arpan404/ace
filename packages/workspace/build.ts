import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";

if (process.platform !== "darwin" && process.platform !== "linux")
  throw new Error("Workspace descriptor safety currently supports macOS and Linux");
const require = createRequire(import.meta.url);
const { include_dir } = z.object({ include_dir: z.string() }).parse(require("node-api-headers"));
const output = fileURLToPath(new URL("./dist/descriptor.node", import.meta.url));
mkdirSync(new URL("./dist", import.meta.url), { recursive: true });
execFileSync(
  process.env.CC || "cc",
  [
    "-std=c11",
    "-D_GNU_SOURCE",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fPIC",
    "-shared",
    ...(process.platform === "darwin" ? ["-undefined", "dynamic_lookup"] : []),
    "-I",
    include_dir,
    fileURLToPath(new URL("./native/descriptor.c", import.meta.url)),
    "-o",
    output,
  ],
  { stdio: "inherit" },
);
