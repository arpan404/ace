import { useRef } from "react";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { useResolvedKeymap, scopeOf } from "@/lib/keybindings.ts";
import { formatKeys, keymap, keymapIds, keymapEntry } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";

export function ShortcutSheet() {
  const layout = useLayout();
  const effective = useResolvedKeymap();
  const list = useRef<HTMLDListElement>(null);
  return (
    <Dialog open={layout.shortcutsOpen} onOpenChange={layout.setShortcutsOpen}>
      <DialogContent size="lg" initialFocus={list}>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogBody>
          <dl ref={list} tabIndex={-1} className="focus-visible:outline-none">
            {keymapIds.map((id) => (
              <div key={id} className="flex min-h-8 items-center gap-3 text-ui">
                <dt className="min-w-0 flex-1">
                  {keymap[id].label}
                  <span className="ml-2 text-xs text-subtle-foreground">
                    {scopeOf(id) === "global" ? "" : scopeOf(id)}
                  </span>
                </dt>
                <dd className="shrink-0 text-muted-foreground">
                  {[effective[id], ...(keymapEntry(id).also ?? [])]
                    .map((keys) => (keys === "shift+/" ? "?" : formatKeys(keys)))
                    .join(" · ")}
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
