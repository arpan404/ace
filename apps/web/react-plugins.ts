import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

/**
 * React with the React Compiler (ADR 0056). The app and its tests share this, so tests run the
 * memoised components the browser runs. The compiler skips a component it cannot prove safe
 * and leaves it as written; `bun run lint` reports those bail-outs (react-hooks rules).
 */
export function reactPlugins(): PluginOption[] {
  return [react(), babel({ presets: [reactCompilerPreset()] })];
}
