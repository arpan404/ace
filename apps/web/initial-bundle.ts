import { relative } from "node:path";
import type { Plugin } from "vite";

/** Closed popups and cold features must never join the page's static startup graph. */
export const forbiddenInitialModules = [
  "/src/features/shell/menu-button-popup.tsx",
  "/src/components/ui/menu.tsx",
  "/src/components/ui/context-menu.tsx",
  "/src/components/ui/dialog.tsx",
  "/src/components/ui/popover.tsx",
  "/src/features/shell/account-menu-content.tsx",
  "/src/features/shell/daemon-menu-content.tsx",
  "/src/features/palette/palette-dialog.tsx",
  "/src/features/projects/project-dialogs.tsx",
  "/@base-ui/react/menu/root/MenuRoot.mjs",
];

/** Inspect the page's actual static closure, independently of chunk names. */
export function initialBundle(): Plugin {
  return {
    name: "ace:initial-bundle",
    generateBundle(_options, bundle) {
      const eager = new Set<string>();
      const visit = (file: string) => {
        const chunk = bundle[file];
        if (!chunk || chunk.type !== "chunk" || eager.has(file)) return;
        eager.add(file);
        for (const imported of chunk.imports) visit(imported);
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (!module.renderedLength) continue;
          if (forbiddenInitialModules.some((suffix) => id.endsWith(suffix)))
            this.error(
              `Forbidden initial page module: ${relative(import.meta.dirname, id)} (${file})`,
            );
        }
      };
      for (const chunk of Object.values(bundle))
        if (chunk.type === "chunk" && chunk.isEntry) visit(chunk.fileName);
      if (process.env["ACE_WORKER_ANALYZE"] !== "1") return;
      this.emitFile({
        type: "asset",
        fileName: "initial-bundle.json",
        source: JSON.stringify(
          [...eager].flatMap((file) => {
            const chunk = bundle[file];
            if (!chunk || chunk.type !== "chunk") return [];
            return [
              {
                file,
                eager: true,
                modules: Object.entries(chunk.modules).flatMap(([id, module]) =>
                  module.renderedLength
                    ? [{ id: relative(import.meta.dirname, id), bytes: module.renderedLength }]
                    : [],
                ),
              },
            ];
          }),
        ),
      });
    },
  };
}
