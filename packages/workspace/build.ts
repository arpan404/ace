import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildWindowsAddon } from "./build-windows-core.ts";

if (process.platform === "win32") {
  // Full matching headers and node.lib are supplied by the build environment.
  const headers = process.env.ACE_WINDOWS_HEADERS_DIR;
  const nodeLib = process.env.ACE_WINDOWS_NODE_LIB;
  const cl = process.env.ACE_WINDOWS_CL ?? "cl";
  if (!headers)
    throw new Error("ACE_WINDOWS_HEADERS_DIR is required for the Windows descriptor build.");
  if (!nodeLib)
    throw new Error("ACE_WINDOWS_NODE_LIB is required for the Windows descriptor build.");
  const output = fileURLToPath(new URL("./dist/descriptor.node", import.meta.url));
  buildWindowsAddon({ headers, nodeLib, out: output, cl });
} else {
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
}
