#!/usr/bin/env node
// Synthetic recorded responses only. Never contacts GitHub or provider CLIs.
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.FORGE_FIXTURE, "utf8"));
const statePath = process.env.FORGE_STATE;
let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  state = { counters: {}, requests: [] };
}
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const body = input ? JSON.parse(input) : undefined;
const path = args[0] === "api" ? args[1] : "auto-merge";
const count = state.counters[path] ?? 0;
const records = config[path];
if (!records) {
  process.stderr.write("Unexpected request");
  process.exit(1);
}
const response = records[Math.min(count, records.length - 1)];
state.counters[path] = count + 1;
state.requests.push({ path, args, ...(body === undefined ? {} : { body }) });
writeFileSync(statePath, JSON.stringify(state));
if (response.wait) {
  setInterval(() => {}, 1000);
} else if (response.repeat) {
  for (let i = 0; i < response.repeat; i++) {
    if (!process.stdout.write(response.text))
      await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  process.stdout.write(response.suffix ?? "");
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
process.exitCode = response.code ?? ((response.status ?? 200) >= 400 ? 1 : 0);
