import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { commandField } from "@/components/ui/command.tsx";
import { cn } from "@/lib/cn.ts";
import { useResolvedKeymap, scopeOf } from "@/lib/keybindings.ts";
import {
  describeKeys,
  formatKeys,
  keymap,
  keymapIds,
  keymapEntry,
  type KeymapId,
  type KeyScope,
} from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";

/** Where each group of shortcuts works, in the order the sheet lists them. */
const scopes: readonly { scope: KeyScope; title: string }[] = [
  { scope: "global", title: "Everywhere" },
  { scope: "home", title: "Thread list" },
  { scope: "thread", title: "Thread" },
  { scope: "composer", title: "Composer" },
  { scope: "newThread", title: "New thread" },
  { scope: "panel", title: "Side panel tabs" },
  { scope: "files", title: "File tree" },
  { scope: "terminal", title: "Terminal" },
  { scope: "notifications", title: "Notifications" },
];

/** What Escape does, which no single binding says. */
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

/**
 * Every shortcut, grouped by where it works, with Escape's meanings in their own group. The
 * search is focused on open; the card sits near the top like the command palette and stays a
 * fixed height (its list scrolls) so filtering never resizes it.
 */
export function ShortcutSheet() {
  const layout = useLayout();
  const effective = useResolvedKeymap();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const matches = (id: KeymapId) =>
    !text ||
    keymap[id].label.toLowerCase().includes(text) ||
    formatKeys(effective[id]).toLowerCase().includes(text) ||
    describeKeys(effective[id]).toLowerCase().includes(text);
  const sections = scopes
    .map(({ scope, title }) => ({
      title,
      ids: keymapIds.filter((id) => scopeOf(id) === scope && matches(id)),
    }))
    .filter((section) => section.ids.length);
  const escapeMatches = escape.filter(
    (label) => !text || label.toLowerCase().includes(text) || "escape esc".includes(text),
  );
  const close = (open: boolean) => {
    if (!open) setQuery("");
    layout.setShortcutsOpen(open);
  };
  return (
    <Dialog open={layout.shortcutsOpen} onOpenChange={close}>
      <DialogContent
        size="lg"
        initialFocus={search}
        style={{
          top: "13vh",
          marginTop: 0,
          marginBottom: 0,
          maxHeight: "min(36rem, 80dvh)",
          minHeight: "16rem",
        }}
      >
        <DialogTitle className="shrink-0 pr-8">Keyboard shortcuts</DialogTitle>
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-1">
          <MagnifyingGlassIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />
          <input
            ref={search}
            type="search"
            aria-label="Search shortcuts"
            placeholder="Search shortcuts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={cn(commandField, "[&::-webkit-search-cancel-button]:appearance-none")}
          />
          {query && (
            <IconButton
              icon={XIcon}
              label="Clear search"
              size="sm"
              tooltip={false}
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            />
          )}
        </div>
        <DialogBody>
          {!sections.length && !escapeMatches.length ? (
            <EmptyState variant="inline" title={`No shortcut matches "${query.trim()}".`} />
          ) : (
            <div className="flex flex-col gap-4">
              {sections.map(({ title, ids }) => (
                <section key={title} aria-label={title}>
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
              ))}
              {escapeMatches.length > 0 && (
                <section aria-label="Escape">
                  <h3 className="pb-1 text-xs font-medium text-muted-foreground">Escape</h3>
                  <dl>
                    {escapeMatches.map((label) => (
                      <Row key={label} label={label} keys={formatKeys("escape")} />
                    ))}
                  </dl>
                </section>
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
