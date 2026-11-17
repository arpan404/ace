#!/usr/bin/env node
import { withoutBenchWorkerPreload } from "@ace/provider-kit/worker";

// A person's daemon runs this entry; a benchmark's worker preload must never reach it.
withoutBenchWorkerPreload(process.env);

// The command table and parser are plain data and pure code. Each command's module loads only
// when it runs, so triage, doctor, help, version and completion work when the rest of ace is
// broken (ADR 0092), and `ace start` carries no other command's code.
const { main } = await import("./cli/main.ts");
await main(process.argv.slice(2));
