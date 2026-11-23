import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL("../packages/provider-kit/src/native-node-sqlite.ts", import.meta.url),
);
/** The modules that wrap node:sqlite themselves and must keep importing the real one. */
const wrappers = ["/provider-kit/src/sqlite.ts", "/provider-kit/src/native-node-sqlite.ts"];

/**
 * With `ACE_STORE=native` (ADR 0222), resolve `node:sqlite` to the native store's stand-in in a
 * test project, so tests that open the database themselves share the store's SQLite library.
 * Unset, the project is returned as it is.
 */
export function storeSwitch<T extends object>(project: T): T {
  if (process.env.ACE_STORE !== "native") return project;
  const plugins = (project as { plugins?: unknown[] }).plugins ?? [];
  return {
    ...project,
    plugins: [
      ...plugins,
      {
        name: "ace-store-switch",
        enforce: "pre",
        resolveId(source: string, importer: string | undefined) {
          if (source !== "node:sqlite" || !importer) return null;
          const path = importer.replaceAll("\\", "/");
          return wrappers.some((wrapper) => path.endsWith(wrapper)) ? null : target;
        },
      },
    ],
  };
}
