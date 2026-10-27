import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

if (process.platform === "win32") {
  // Handles become fds through Node's own libuv, so this needs the full Node headers (with uv.h)
  // and node.lib; the build environment supplies them and cl.exe.
  const headers = process.env.ACE_WINDOWS_HEADERS_DIR;
  const nodeLib = process.env.ACE_WINDOWS_NODE_LIB;
  if (!headers || !existsSync(join(headers, "uv.h")))
    throw new Error("ACE_WINDOWS_HEADERS_DIR must name the full Node headers (with uv.h).");
  if (!nodeLib || !existsSync(nodeLib))
    throw new Error("ACE_WINDOWS_NODE_LIB must name the matching node.lib.");
  mkdirSync(new URL("./dist", import.meta.url), { recursive: true });
  execFileSync(
    process.env.ACE_WINDOWS_CL ?? "cl",
    [
      "/nologo",
      "/MD",
      "/LD",
      "/O2",
      "/W4",
      "/std:c11",
      "/I",
      headers,
      fileURLToPath(new URL("./native/windows/descriptor.c", import.meta.url)),
      "/link",
      `/OUT:${fileURLToPath(new URL("./dist/descriptor.node", import.meta.url))}`,
      nodeLib,
      "kernel32.lib",
    ],
    { stdio: "inherit" },
  );
  process.exit(0);
}
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
