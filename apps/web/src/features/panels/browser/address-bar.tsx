import { ClockCounterClockwiseIcon, GlobeSimpleIcon } from "@phosphor-icons/react";
import {
  displayAddress,
  parseAddress,
  suggestAddresses,
  type AddressSuggestion,
} from "@ace/ui-core";
import { useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

const reasons = {
  empty: "Type an address, like localhost:3000 or example.com.",
  not_address: "That isn't an address. Try one like localhost:3000 or example.com.",
  scheme: "ace's browser opens web pages (http and https) only.",
} as const;

/**
 * The browser's address: shows the page at rest, edits in place, suggests addresses this thread
 * runs or visited as you type, and opens what you enter. Never searches the web for text that
 * isn't an address; it says so instead. Escape puts the page's address back. At rest the site
 * reads first and the rest of the address is muted; focused, the whole address is there to edit.
 * `readOnly` is a preview's: the dev server's address, selectable to copy, in the same capsule.
 */
export function AddressBar(props: {
  url: string | undefined;
  known?: readonly AddressSuggestion[];
  loading: boolean;
  readOnly?: boolean;
  /** Why the address can't be changed right now, if it can't. */
  disabled?: string | undefined;
  /** Shown as the field's description (typing an address takes control from an agent). */
  hint?: string | undefined;
  autoFocus?: boolean;
  /** Opens what was entered; a read-only address has none. */
  onGo?: (url: string) => void;
  /** At the field's start in place of the globe (the site's security and access). */
  lead?: ReactNode;
  /** At the field's end (Make private). */
  trail?: ReactNode;
  /** A private page's field is tinted. */
  tone?: "private" | undefined;
  className?: string;
}) {
  const shown = displayAddress(props.url ?? "");
  const [draft, setDraft] = useState<string>();
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const hintId = useId();
  const errorId = useId();
  const editing = draft !== undefined;
  const text = draft ?? shown;
  const suggestions = editing ? suggestAddresses(draft, props.known ?? []) : [];
  const open = editing && suggestions.length > 0;
  // At rest the field's own text is hidden under the same text with the site emphasised (the
  // overlay centres vertically as the wrapper's only flex item).
  const resting = !focused && !editing && text !== "";
  const site = text.includes("://") ? text : text.split(/(?=[/?#])/)[0];
  const field = useRef<HTMLInputElement>(null);
  const go = (url: string) => {
    setDraft(undefined);
    setActive(-1);
    setError(undefined);
    field.current?.blur();
    props.onGo?.(url);
  };
  const submit = () => {
    const picked = suggestions[active];
    if (picked) return go(picked.url);
    const parsed = parseAddress(text);
    if (parsed.ok) go(parsed.url);
    else setError(reasons[parsed.reason]);
  };
  return (
    <div className={cn("relative min-w-0", props.className)}>
      <div
        className={cn(
          "flex h-8 min-w-0 items-center rounded-full transition-[background-color,box-shadow] duration-(--dur-1)",
          props.lead ? "gap-1 px-1" : "gap-2 px-3",
          props.tone === "private"
            ? "bg-status-needs-you/9"
            : // Focus lightens the capsule, never an accent ring.
              "bg-foreground/5 hover:bg-foreground/8 focus-within:bg-foreground/10",
          error && "shadow-[0_0_0_1px_var(--destructive)]",
        )}
      >
        {props.lead ??
          (props.loading ? (
            <Spinner />
          ) : (
            <Icon icon={GlobeSimpleIcon} size={14} className="text-subtle-foreground" />
          ))}
        <span className="relative flex h-full min-w-0 flex-1 items-center">
          <input
            ref={field}
            {...(props.readOnly
              ? {}
              : {
                  role: "combobox",
                  "aria-expanded": open,
                  "aria-controls": listId,
                  "aria-autocomplete": "list" as const,
                  "aria-activedescendant": active >= 0 ? `${listId}-${active}` : undefined,
                })}
            aria-label="Address"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : props.hint || props.disabled ? hintId : undefined}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new browser tab starts at its address.
            autoFocus={props.autoFocus}
            readOnly={props.readOnly || props.disabled !== undefined}
            placeholder="Enter an address"
            value={text}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            data-editing={editing || undefined}
            onFocus={(event) => {
              setFocused(true);
              event.currentTarget.select();
            }}
            onBlur={() => {
              setFocused(false);
              setDraft(undefined);
              setActive(-1);
              setError(undefined);
            }}
            onChange={(event) => {
              if (props.readOnly) return;
              setDraft(event.target.value);
              setActive(-1);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (props.readOnly) return;
              if (event.key === "Enter") submit();
              else if (event.key === "Escape" && (editing || error)) {
                setDraft(undefined);
                setError(undefined);
                event.currentTarget.select();
              } else if (event.key === "ArrowDown" && open)
                setActive((active + 1) % suggestions.length);
              else if (event.key === "ArrowUp" && open)
                setActive(active <= 0 ? suggestions.length - 1 : active - 1);
              else return;
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              "h-full w-full bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground focus:opacity-100 read-only:cursor-default",
              resting && "opacity-0",
            )}
          />
          {resting && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 truncate text-ui text-subtle-foreground"
            >
              <span className="text-foreground">{site}</span>
              {text.slice(site?.length ?? 0)}
            </span>
          )}
        </span>
        {props.trail}
      </div>
      <span id={hintId} className="sr-only">
        {props.disabled ?? props.hint}
      </span>
      {error && (
        <p
          id={errorId}
          role="alert"
          data-native-overlay=""
          className="absolute top-full right-0 left-0 z-10 mt-1.5 rounded-lg border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-[var(--glass-shadow)]"
        >
          {error}
        </p>
      )}
      {open && !error && (
        <ul
          id={listId}
          role="listbox"
          data-native-overlay=""
          aria-label="Suggested addresses"
          className="@container absolute top-full right-0 left-0 z-10 mt-1.5 flex flex-col overflow-hidden rounded-lg border bg-popover p-1 shadow-[var(--glass-shadow)]"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.url}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keep the field focused so the click lands as a pick, not a blur.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => go(suggestion.url)}
              onPointerMove={() => setActive(index)}
              className={cn(
                "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-ui select-none",
                index === active && "bg-accent",
              )}
            >
              <Icon
                icon={suggestion.detail === "Visited" ? ClockCounterClockwiseIcon : GlobeSimpleIcon}
                size={14}
                className="shrink-0 text-muted-foreground"
              />
              {/* The address is what you pick: it gets the room, the detail what is left. */}
              <span className="min-w-0 flex-1 truncate text-foreground">
                {displayAddress(suggestion.url)}
              </span>
              {/* Truncated rather than hidden: at the default 520px panel the popup is ~320px. */}
              <span className="max-w-[45%] min-w-0 shrink truncate text-xs text-muted-foreground @max-[13rem]:hidden">
                {suggestion.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
