/**
 * Explicit Windows-only probe/build entry for the bounded W04 handle core.
 *
 * Produces an independently loadable dist/windows-core.node exposing exactly
 * openRoot, openDirectoryAt, openFileAt, identityOf, statAt, names. It does NOT activate the
 * default daemon, hook any build, or change the root postinstall (which still
 * builds only the POSIX descriptor addon).
 *
 * Usage:
 *   node build-windows-core.ts --probe-only [--headers <dir> --node-lib <path>]
 *   node build-windows-core.ts --headers <dir> --node-lib <path> [--out <path>] [--cl <exe>]
 *
 * --headers must point at the FULL matching Node headers for the runtime that
 * will load the addon (the directory containing node_api.h AND uv.h — the
 * minimal node-api-headers package has no uv.h and is rejected). --node-lib
 * must point at the matching node.lib so the libuv helpers resolve to the
 * running Node's libuv. Nothing is downloaded; the MSVC toolchain (cl.exe)
 * must already be installed — run from a VS Developer Prompt or pass --cl.
 *
 * Normative build gates (docs/research/windows-workspace-backend.md section 2):
 * - /MD (shared UCRT: one process-wide fd table, so an addon-created fd is
 *   the fd Node fs and child stdio see; /MT gives each module a private fd
 *   table and cross-boundary fds are invalid).
 * - uv.h declares uv_open_osfhandle/uv_get_osfhandle (the probe greps for
 *   both; the link against node.lib is gate U1).
 * - No private-CRT fd table use: sources must go through the uv_ wrappers
 *   (the probe rejects direct _open_osfhandle/_get_osfhandle calls).
 *
 * Compilation is verified on a Windows host only. On macOS/Linux this entry
 * supports --probe-only for layout/header checks; a real build throws.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = [
  "validate_component.c",
  "nt_bridge.c",
  "volume_root.c",
  "child_open.c",
  "file_identity.c",
  "directory_metadata.c",
  "windows_core_addon.c",
];

const MAX_LINES = 400;

interface Options {
  headers: string | undefined;
  nodeLib: string | undefined;
  out: string;
  probeOnly: boolean;
  cl: string;
  help: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  node build-windows-core.ts --probe-only [--headers <dir> --node-lib <path>]",
    "  node build-windows-core.ts --headers <dir> --node-lib <path> [--out <path>] [--cl <exe>]",
    "",
    "Windows-only build for dist/windows-core.node. Requires the full matching",
    "Node headers (node_api.h + uv.h) and node.lib. Never downloads toolchains.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    headers: undefined,
    nodeLib: undefined,
    out: fileURLToPath(new URL("./dist/windows-core.node", import.meta.url)),
    probeOnly: false,
    cl: "cl",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    const takesValue = (name: string): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${name}\n${usage()}`);
      i++;
      return value;
    };
    if (arg === "--headers") options.headers = takesValue("--headers");
    else if (arg === "--node-lib") options.nodeLib = takesValue("--node-lib");
    else if (arg === "--out") options.out = takesValue("--out");
    else if (arg === "--cl") options.cl = takesValue("--cl");
    else if (arg === "--probe-only") options.probeOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
}

interface Finding {
  ok: boolean;
  line: string;
}

/** Layout + source-hygiene checks that run on any host. */
function probeLayout(nativeDir: string): Finding[] {
  const findings: Finding[] = [];
  // Direct private-CRT calls (_open_osfhandle/_get_osfhandle) are forbidden;
  // the uv_open_osfhandle/uv_get_osfhandle wrappers are required instead.
  // Matches a bare _open_osfhandle( / _get_osfhandle( call outside // comments
  // while ignoring the uv_-prefixed wrappers and prose mentions.
  const directCrt = /(^|[^A-Za-z0-9_])_((open)|(get))_osfhandle\s*\(/;
  for (const file of [...SOURCES, "windows_core.h"]) {
    const path = join(nativeDir, file);
    if (!existsSync(path)) {
      findings.push({ ok: false, line: `missing ${file}` });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").length;
    findings.push({
      ok: lines <= MAX_LINES,
      line: `${file}: ${lines} lines (limit ${MAX_LINES})`,
    });
    if (file.endsWith(".c")) {
      const stripped = text
        .split("\n")
        .map((line) => line.split("//")[0] as string)
        .join("\n");
      const bad = directCrt.test(stripped);
      findings.push({
        ok: !bad,
        line: !bad
          ? `${file}: fd bridge uses uv_ wrappers only`
          : `${file}: direct private-CRT fd calls are forbidden (use uv_ wrappers)`,
      });
    }
  }
  return findings;
}

/** Header/node.lib checks. Skipped when the paths are not provided. */
function probeToolchain(options: Options): Finding[] {
  const findings: Finding[] = [];
  if (options.headers === undefined) {
    findings.push({ ok: true, line: "--headers not given: header checks skipped" });
  } else {
    for (const header of ["node_api.h", "uv.h"]) {
      const path = join(options.headers, header);
      findings.push({
        ok: existsSync(path),
        line: existsSync(path)
          ? `headers: found ${header}`
          : `headers: missing ${header} in ${options.headers}`,
      });
    }
    const uvPath = join(options.headers, "uv.h");
    if (existsSync(uvPath)) {
      const uv = readFileSync(uvPath, "utf8");
      for (const symbol of ["uv_open_osfhandle", "uv_get_osfhandle"]) {
        findings.push({
          ok: uv.includes(symbol),
          line: uv.includes(symbol)
            ? `uv.h declares ${symbol}`
            : `uv.h is missing ${symbol} (need full Node headers, not node-api-headers)`,
        });
      }
    }
  }
  if (options.nodeLib === undefined) {
    findings.push({ ok: true, line: "--node-lib not given: node.lib check skipped" });
  } else {
    findings.push({
      ok: existsSync(options.nodeLib),
      line: existsSync(options.nodeLib)
        ? `found node.lib at ${options.nodeLib}`
        : `missing node.lib at ${options.nodeLib}`,
    });
  }
  return findings;
}

function findCl(explicit: string): string {
  if (explicit !== "cl") return explicit;
  try {
    const found = execFileSync("where", ["cl"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    if (found) return found;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(
    "cl.exe not found on PATH. Run from a VS Developer Prompt or pass --cl <path>. " +
      "No toolchain is downloaded by this script.",
  );
}

function runProbe(options: Options): boolean {
  const nativeDir = fileURLToPath(new URL("./native/windows", import.meta.url));
  const findings = [...probeLayout(nativeDir), ...probeToolchain(options)];
  let ok = true;
  for (const finding of findings) {
    console.log(`${finding.ok ? "PASS" : "FAIL"}  ${finding.line}`);
    if (!finding.ok) ok = false;
  }
  if (process.platform !== "win32") {
    console.log("NOTE  not a Windows host: compilation unverified here; build on a Windows VM.");
  } else if (options.probeOnly) {
    try {
      const cl = findCl(options.cl);
      console.log(`NOTE  toolchain: ${cl}`);
    } catch (error) {
      console.log(`NOTE  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ok;
}

function runBuild(options: Options): void {
  if (process.platform !== "win32")
    throw new Error(
      "windows-core build requires a Windows host (compilation unverified on " +
        `${process.platform}). Use --probe-only here and build on a Windows VM.`,
    );
  if (options.headers === undefined || options.nodeLib === undefined)
    throw new Error(`--headers and --node-lib are required for a build.\n${usage()}`);
  if (!runProbe(options)) throw new Error("Probe failed; refusing to build.");
  const cl = findCl(options.cl);
  const root = fileURLToPath(new URL(".", import.meta.url));
  const nativeDir = join(root, "native", "windows");
  mkdirSync(join(root, "dist"), { recursive: true });
  execFileSync(
    cl,
    [
      "/nologo",
      "/MD", // Shared UCRT: one process-wide fd table (normative, see header).
      "/LD", // Build a DLL (.node).
      "/O2",
      "/W4",
      "/std:c11",
      "/I",
      options.headers,
      "/I",
      nativeDir,
      ...SOURCES.map((file) => join(nativeDir, file)),
      "/link",
      `/OUT:${options.out}`,
      options.nodeLib,
      "kernel32.lib",
      "advapi32.lib",
    ],
    { stdio: "inherit" },
  );
  const bytes = statSync(options.out).size;
  console.log(`Built ${options.out} (${bytes} bytes)`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
} else if (options.probeOnly) {
  if (!runProbe(options)) process.exit(1);
} else {
  runBuild(options);
}
