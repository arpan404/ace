import type { Plugin } from "vite";

/**
 * Socket traffic is decoded from JSON, whose object graph cannot contain reference cycles.
 * Zod's default container memoizer only preserves cycles/shared references, and retaining its
 * factory adds code and per-parse work to every wire worker. Keep ordinary object validation
 * and its JIT parser, but omit reference-identity memoization in these private JSON workers.
 * The corpus equivalence suite checks
 * decoded frames, invalid frames, defaults and transforms against the unmodified build.
 */
export function workerJsonZod(): Plugin {
  return {
    name: "ace:worker-json-zod",
    transform(code, id) {
      if (id.endsWith("zod/v4/core/schemas.js")) {
        return { code: code.replaceAll("core.globalConfig.memoizer", "undefined"), map: null };
      }
      if (!id.endsWith("zod/v4/classic/schemas.js")) return null;
      const install =
        /function _ensureDefaultMemoizer\(\) \{\s*if \(!core\.globalConfig\.memoizer\)\s*core\.config\(\{ memoizer: core\.memoizer\(\) \}\);\s*\}/;
      if (!install.test(code))
        this.error("Zod's default memoizer changed; review the JSON worker optimization.");
      return { code: code.replace(install, "function _ensureDefaultMemoizer() {}"), map: null };
    },
  };
}
