import { spadeAppCategories, type SpadeCatalogueEntry } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { appSections, type AppFilter } from "./spade-app-list.ts";
import { ServerChoice, waysOf } from "./spade-app-row.tsx";
import { useRecentApps } from "./spade-recent-apps.ts";

/**
 * Connect an app: the catalogue of apps' own servers, searchable and by category, with the apps
 * already added and the ones reached for lately first; then any other server by its address.
 * Each app says in words whether it signs in with a click, needs a key, or is coming. Signing in
 * opens the app's page in the person's browser; the dialog closes and the app's row in Settings
 * follows the sign-in.
 */
export function AddConnectorDialog(props: {
  catalogue: readonly SpadeCatalogueEntry[];
  /** The apps already added, by catalogue id, with their state in words. */
  added: ReadonlyMap<string, string>;
  onClose(): void;
}) {
  const searchId = useId();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<AppFilter>("all");
  const [recent, remember] = useRecentApps();
  const sections = appSections(props.catalogue, {
    text,
    filter,
    added: new Set(props.added.keys()),
    recent,
  });
  const empty = sections.every((section) => section.entries.length === 0);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader className="gap-3">
          <DialogTitle>Connect an app</DialogTitle>
          <label htmlFor={searchId} className="sr-only">
            Search apps
          </label>
          <Input
            id={searchId}
            type="search"
            // The dialog opens for this: the search takes the typing.
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={`Search ${props.catalogue.length} apps`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {!text.trim() && <Categories filter={filter} onFilter={setFilter} />}
        </DialogHeader>
        <DialogBody>
          {empty ? (
            <p className="py-2 text-ui text-muted-foreground">
              {`No app matches “${text.trim()}”. Add its server by address below.`}
            </p>
          ) : (
            sections.map((section) => (
              <section
                key={section.key}
                aria-label={section.title ?? "Apps found"}
                className="flex flex-col gap-1"
              >
                {section.title && (
                  <h3 className="text-xs font-medium text-subtle-foreground">{section.title}</h3>
                )}
                <ul className="flex flex-col divide-y divide-border">
                  {section.entries.map((entry) => (
                    <li key={entry.id} className="py-2.5">
                      <ServerChoice
                        name={entry.name}
                        catalogue={entry.id}
                        notes={entry.notes}
                        keyUrl={entry.keyUrl}
                        setup={entry.setup}
                        ready={entry.ready}
                        ways={waysOf(entry)}
                        added={props.added.get(entry.id)}
                        draft={{ catalogue: entry.id }}
                        onDone={props.onClose}
                        onStart={() => remember(entry.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          <ByAddress onDone={props.onClose} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** The categories as words: the chosen one in the text colour, the rest quieter. */
function Categories(props: { filter: AppFilter; onFilter(filter: AppFilter): void }) {
  const choices: { id: AppFilter; label: string }[] = [
    { id: "all", label: "All" },
    ...spadeAppCategories,
  ];
  return (
    <div
      role="group"
      aria-label="Categories"
      {...part("segmented", undefined, "app-categories")}
      className="flex flex-wrap gap-x-3 gap-y-1"
    >
      {choices.map((choice) => {
        const chosen = choice.id === props.filter;
        return (
          <button
            key={choice.id}
            type="button"
            aria-pressed={chosen}
            {...part("segment", chosen && "selected", choice.id)}
            onClick={() => props.onFilter(choice.id)}
            className={cn(
              "rounded-sm text-ui transition-colors duration-(--motion-fast) focus-ring",
              chosen
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Any other remote MCP server, by its address. A server on the person's own machine or network
 * is marked so here, explicitly: only then may its sign-in reach local addresses.
 */
function ByAddress(props: { onDone(): void }) {
  const field = useId();
  const localId = useId();
  const [address, setAddress] = useState("");
  const [local, setLocal] = useState(false);
  const typed = address.trim();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <label htmlFor={field} className="w-fit text-ui font-medium">
        Another server
      </label>
      <Input
        id={field}
        type="url"
        spellCheck={false}
        placeholder="https://example.com/mcp"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={localId} className="text-ui text-foreground">
          On my own machine or network
        </label>
        <Switch id={localId} checked={local} onCheckedChange={setLocal} />
      </div>
      {/^https?:\/\/\S+/i.test(typed) && (
        <ServerChoice
          name={hostOf(typed)}
          ready="sign_in"
          ways={["sign_in", "token"]}
          draft={{ url: typed, ...(local ? { local: true } : {}) }}
          onDone={props.onDone}
        />
      )}
    </div>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
