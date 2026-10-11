import { defineConfig } from "@playwright/test";
import config, { fakeWebServer } from "./playwright.config.ts";

/** Run the fake project without starting the real-daemon server or provider processes. */
export default defineConfig({
  ...config,
  projects: (config.projects ?? []).filter((project) => project.name === "fake"),
  webServer: fakeWebServer,
});
