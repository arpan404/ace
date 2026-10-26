import { inject } from "vitest";
import { prebuiltPerfApp } from "./perf-app.ts";

declare module "vitest" {
  export interface ProvidedContext {
    webPerfBuild: string;
  }
}

/** Vitest setup file: each worker serves the build its run's global setup made. */
process.env[prebuiltPerfApp] = inject("webPerfBuild");
