#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createCursorAccountDriver, discoverCursorSdk } from "@ace/adapter-cursor";
import {
  recordApprovedCursorSdkBatch,
  recordFullAccessCursorSdkBatch,
} from "./cursor-sdk-batch.ts";
export {
  recordApprovedCursorSdkBatch,
  recordFullAccessCursorSdkBatch,
} from "./cursor-sdk-batch.ts";

const namespace = "fixtures/cursor-sdk/1.0.35/composer-2.5";
async function main() {
  const args = z
    .union([
      z.tuple([z.literal("--owner-approved-2026-10-03")]),
      z.tuple([
        z.literal("--owner-approved-behavioural-2026-10-03"),
        z.literal("--recording-policy=full-access"),
      ]),
    ])
    .parse(process.argv.slice(2));
  const instance = {
    id: "cursor-fixture",
    homeDir: join(homedir(), ".ace-fixtures", "cursor-sdk"),
  };
  const launchEnv = { ...process.env };
  if (launchEnv.CURSOR_API_KEY !== undefined)
    throw new Error(
      "Fixture browser sign-in requires the SDK-owned store; remove the launch environment override",
    );
  const installation = await discoverCursorSdk();
  if (!installation.supported || installation.version !== "1.0.35")
    throw new Error(installation.error ?? "SDK 1.0.35 required");
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error("Recording interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const auth = await createCursorAccountDriver({
      launchEnv,
      stopInstance: async () => {},
    }).status(instance, lifetime.signal);
    if (auth.status !== "logged-in" || auth.source !== "sdk-store")
      throw new Error("Sign in to the fresh isolated fixture instance through the daemon first");
    const record =
      args[0] === "--owner-approved-behavioural-2026-10-03"
        ? recordFullAccessCursorSdkBatch
        : recordApprovedCursorSdkBatch;
    await record(resolve(import.meta.dirname, "../../..", namespace), instance, {
      signal: lifetime.signal,
      now: Date.now,
      id: randomUUID,
      launchEnv,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Recording failed"}\n`);
    process.exitCode = 1;
  });
