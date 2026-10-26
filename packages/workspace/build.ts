import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const output = fileURLToPath(new URL("./dist/descriptor.node", import.meta.url));
const native = fileURLToPath(new URL("./native", import.meta.url));
mkdirSync(new URL("./dist", import.meta.url), { recursive: true });

if (process.platform === "win32") {
  // The Windows sources bridge handles to fds through Node's own libuv
  // (uv_open_osfhandle), so they need the full matching Node headers with
  // uv.h and node.lib; the minimal node-api-headers package has no uv.h.
  // Nothing is downloaded: the build environment supplies both and cl.exe.
  const headers = process.env.ACE_WINDOWS_HEADERS_DIR;
  const nodeLib = process.env.ACE_WINDOWS_NODE_LIB;
  if (!headers || !existsSync(join(headers, "uv.h")))
    throw new Error("ACE_WINDOWS_HEADERS_DIR must name the full Node headers (with uv.h).");
  if (!nodeLib || !existsSync(nodeLib))
    throw new Error("ACE_WINDOWS_NODE_LIB must name the matching node.lib.");
  const sources = join(native, "windows");
  execFileSync(
    process.env.ACE_WINDOWS_CL ?? "cl",
    [
      "/nologo",
      "/MD", // Fds stay in Node's libuv runtime, never a private CRT table.
      "/LD",
      "/O2",
      "/W4",
      "/std:c11",
      "/I",
      headers,
      "/I",
      sources,
      ...readdirSync(sources)
        .filter((file) => file.endsWith(".c"))
        .map((file) => join(sources, file)),
      "/link",
      `/OUT:${output}`,
      nodeLib,
      "kernel32.lib",
    ],
    { stdio: "inherit" },
  );
} else if (process.platform === "darwin" || process.platform === "linux") {
  const require = createRequire(import.meta.url);
  const { include_dir } = z.object({ include_dir: z.string() }).parse(require("node-api-headers"));
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
      join(native, "descriptor.c"),
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
} else {
  throw new Error("Workspace descriptor safety supports macOS, Linux and Windows");
}
