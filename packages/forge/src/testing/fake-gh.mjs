#!/usr/bin/env node
// Synthetic recorded responses only. Never contacts GitHub or provider CLIs.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  watch,
  mkdirSync,
  rmdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
const config = JSON.parse(readFileSync(process.env.FORGE_FIXTURE, "utf8"));
const statePath = process.env.FORGE_STATE;
// Concurrent fake processes share one state file; serialise each read-modify-write.
const lockPath = `${statePath}.lock`;
const pause = new Int32Array(new SharedArrayBuffer(4));
function locked(update) {
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  try {
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      state = { counters: {}, requests: [] };
    }
    const result = update(state);
    // Readers never observe a half-written file.
    writeFileSync(`${statePath}.next`, JSON.stringify(state));
    renameSync(`${statePath}.next`, statePath);
    return result;
  } finally {
    rmdirSync(lockPath);
  }
}
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const body = input ? JSON.parse(input) : undefined;
const path =
  args[0] === "api"
    ? args[1] === "graphql" &&
      config["merge-state-write"] &&
      body?.query?.trimStart().startsWith("mutation")
      ? "merge-state-write"
      : args[1] === "graphql" &&
          config["merge-state-read"] &&
          body?.query?.includes("autoMergeRequest")
        ? "merge-state-read"
        : args[1] === "graphql" && body?.query?.includes("query StackChecks(")
          ? "stack-checks"
          : args[1] === "graphql" && body?.query?.includes("query StackMergeScope(")
            ? "stack-scope"
            : args[1]
    : args[0] === "stack"
      ? `stack-${args[1]}${args.includes("--continue") ? "-continue" : args.includes("--abort") ? "-abort" : ""}`
      : "auto-merge";
const fixturePath =
  path === "graphql"
    ? (Object.keys(config).find(
        (key) =>
          key.startsWith("graphql:") &&
          typeof body?.query === "string" &&
          body.query.includes(key.slice(8)),
      ) ?? path)
    : path;
const records = config[fixturePath];
if (!records) {
  process.stderr.write("Unexpected request");
  process.exit(1);
}
const response = locked((state) => {
  const count = state.counters[fixturePath] ?? 0;
  state.counters[fixturePath] = count + 1;
  state.requests.push({ path, args, ...(body === undefined ? {} : { body }) });
  return records[Math.min(count, records.length - 1)];
});
if (response.barrier) {
  const dir = dirname(process.env.FORGE_FIXTURE);
  const gate = join(dir, response.barrier);
  const released = Promise.withResolvers();
  const observer = watch(dir, () => {
    if (existsSync(gate)) released.resolve();
  });
  observer.on("error", released.reject);
  try {
    if (existsSync(gate)) released.resolve();
    await released.promise;
  } finally {
    observer.close();
  }
}
if (response.wait) {
  if (response.waitMarker) writeFileSync(response.waitMarker, "waiting");
  setInterval(() => {}, 1000);
} else if (response.repeat) {
  for (let i = 0; i < response.repeat; i++) {
    if (!process.stdout.write(response.text))
      await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  process.stdout.write(response.suffix ?? "");
} else if (response.offline) {
  // gh reached no host: it prints no HTTP response and fails.
  process.stderr.write("error connecting to api.github.com");
} else {
  if (args.includes("--include")) {
    process.stdout.write(`HTTP/2.0 ${response.status ?? 200} status\r\n`);
    for (const [key, value] of Object.entries(response.headers ?? {}))
      process.stdout.write(`${key}: ${value}\r\n`);
    process.stdout.write("\r\n");
  }
  process.stdout.write(response.raw ?? JSON.stringify(response.body ?? null));
}
if (response.stderr) process.stderr.write(response.stderr);
process.exitCode = response.code ?? (response.offline || (response.status ?? 200) >= 400 ? 1 : 0);
