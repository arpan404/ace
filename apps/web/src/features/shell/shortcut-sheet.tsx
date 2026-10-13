import { useRef } from "react";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { useResolvedKeymap, scopeOf } from "@/lib/keybindings.ts";
import { formatKeys, keymap, keymapIds, keymapEntry, type KeyScope } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";

/** Where each group of shortcuts works, in the order the sheet lists them. */
const scopes: readonly { scope: KeyScope; title: string }[] = [
  { scope: "global", title: "Everywhere" },
  { scope: "home", title: "Thread list" },
  { scope: "thread", title: "Thread" },
  { scope: "composer", title: "Composer" },
  { scope: "terminal", title: "Terminal" },
  { scope: "activity", title: "Activity" },
  { scope: "notifications", title: "Notifications" },
];

/** What Escape does where, which no single binding says. */
const escape: readonly string[] = [
  "Close a dialog, menu or popover",
  "Stop the working agent from an empty composer",
  "Let go of the threads picked in the list",
];

/** A row: what the shortcut does, then its keys. */
function Row(props: { label: string; keys: string }) {
  return (
    <div className="flex min-h-8 items-center gap-3 text-ui">
      <dt className="min-w-0 flex-1">{props.label}</dt>
      <dd className="shrink-0 text-muted-foreground">{props.keys}</dd>
    </div>
  );
}

/** Every shortcut, grouped by where it works, with Escape's meanings in their own group. */
export function ShortcutSheet() {
  const layout = useLayout();
  const effective = useResolvedKeymap();
  const list = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={layout.shortcutsOpen} onOpenChange={layout.setShortcutsOpen}>
      <DialogContent size="lg" initialFocus={list}>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogBody>
          <div ref={list} tabIndex={-1} className="flex flex-col gap-4 focus-visible:outline-none">
            {scopes.map(({ scope, title }) => {
              const ids = keymapIds.filter((id) => scopeOf(id) === scope);
              if (!ids.length) return null;
              return (
                <section key={scope} aria-label={title}>
                  <h3 className="pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
                  <dl>
                    {ids.map((id) => (
                      <Row
                        key={id}
                        label={keymap[id].label}
                        keys={[effective[id], ...(keymapEntry(id).also ?? [])]
                          .map((keys) => (keys === "shift+/" ? "?" : formatKeys(keys)))
                          .join(" · ")}
                      />
                    ))}
                  </dl>
                </section>
              );
            })}
            <section aria-label="Escape">
              <h3 className="pb-1 text-xs font-medium text-muted-foreground">Escape</h3>
              <dl>
                {escape.map((label) => (
                  <Row key={label} label={label} keys={formatKeys("escape")} />
                ))}
              </dl>
            </section>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
