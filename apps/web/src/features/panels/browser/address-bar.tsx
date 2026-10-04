import { ClockCounterClockwiseIcon, GlobeSimpleIcon, PlayIcon } from "@phosphor-icons/react";
import {
  displayAddress,
  parseAddress,
  suggestAddresses,
  type AddressSuggestion,
} from "@ace/ui-core";
import { useId, useRef, useState } from "react";
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
 * isn't an address; it says so instead. Escape puts the page's address back.
 */
export function AddressBar(props: {
  url: string | undefined;
  known: readonly AddressSuggestion[];
  loading: boolean;
  /** Why the address can't be changed right now, if it can't. */
  disabled?: string | undefined;
  /** Shown as the field's description (typing an address takes control from an agent). */
  hint?: string | undefined;
  autoFocus?: boolean;
  onGo(url: string): void;
  className?: string;
}) {
  const shown = displayAddress(props.url ?? "");
  const [draft, setDraft] = useState<string>();
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string>();
  const listId = useId();
  const hintId = useId();
  const errorId = useId();
  const editing = draft !== undefined;
  const text = draft ?? shown;
  const suggestions = editing ? suggestAddresses(draft, props.known) : [];
  const open = editing && suggestions.length > 0;
  const field = useRef<HTMLInputElement>(null);
  const go = (url: string) => {
    setDraft(undefined);
    setActive(-1);
    setError(undefined);
    field.current?.blur();
    props.onGo(url);
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
          "flex h-8 min-w-0 items-center gap-2 rounded-full px-3 transition-[background-color,box-shadow] duration-(--dur-1)",
          "bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] hover:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
          "focus-within:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] focus-within:shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--ring)_60%,transparent)]",
          error && "shadow-[0_0_0_1px_var(--destructive)]",
        )}
      >
        {props.loading ? (
          <Spinner />
        ) : (
          <Icon icon={GlobeSimpleIcon} size={14} className="text-subtle-foreground" />
        )}
        <input
          ref={field}
          role="combobox"
          aria-label="Address"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : props.hint || props.disabled ? hintId : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new browser tab starts at its address.
          autoFocus={props.autoFocus}
          readOnly={props.disabled !== undefined}
          placeholder="Enter an address"
          value={text}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => {
            setDraft(undefined);
            setActive(-1);
            setError(undefined);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setActive(-1);
            setError(undefined);
          }}
          onKeyDown={(event) => {
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
          className="h-full min-w-0 flex-1 bg-transparent text-center text-ui text-foreground outline-none placeholder:text-subtle-foreground focus:text-left read-only:cursor-default"
        />
      </div>
      <span id={hintId} className="sr-only">
        {props.disabled ?? props.hint}
      </span>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="absolute top-full right-0 left-0 z-[5] mt-1.5 rounded-lg bg-popover px-3 py-2 text-xs text-muted-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_rgb(0_0_0/0.18)]"
        >
          {error}
        </p>
      )}
      {open && !error && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested addresses"
          className="absolute top-full right-0 left-0 z-[5] mt-1.5 flex flex-col overflow-hidden rounded-xl bg-popover p-1 shadow-[0_0_0_1px_var(--border),0_12px_32px_rgb(0_0_0/0.22)]"
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
                icon={suggestion.detail === "Visited" ? ClockCounterClockwiseIcon : PlayIcon}
                size={14}
                className="text-subtle-foreground"
              />
              <span className="min-w-0 truncate text-foreground">
                {displayAddress(suggestion.url)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                {suggestion.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
