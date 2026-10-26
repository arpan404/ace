import { inject } from "vitest";
import { prebuiltPerfApp } from "./perf-app.ts";
import "./perf-build-setup.ts";

/** Vitest setup file: each worker serves the build its run's global setup made. */
process.env[prebuiltPerfApp] = inject("webPerfBuild");
