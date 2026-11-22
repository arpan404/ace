import { CaretDownIcon, CaretRightIcon, CaretUpIcon, XIcon } from "@ace/icons";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { matchLimit } from "./use-find.ts";
import type { FindInFile, FindOption } from "./use-find-in-file.ts";

/*
 * Find and replace in the file: a compact solid widget floating at the code's top right, so
 * opening it never moves the text. Replace waits behind the caret toggle at its left. Each field
 * is a box inside its 32px row, so its focus ring stays in the widget.
 */

const field =
  "h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring";

/** Alt+C, Alt+W, Alt+R and Alt+L toggle the options, by key position (macOS types symbols). */
const optionKeys: Record<string, FindOption> = {
  KeyC: "caseSensitive",
  KeyW: "wholeWord",
  KeyR: "regex",
  KeyL: "inSelection",
};

export function EditorFindBar(props: { finder: FindInFile; mac: boolean }) {
  const { finder } = props;
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const focusReplace = useRef(finder.replacing);
  useEffect(() => {
    if (focusReplace.current) replaceInput.current?.focus();
    else input.current?.focus();
  }, []);
  const canStep = finder.status === "ready" && finder.matches.length > 0;

  /** Keys both fields share; true when the key was handled. */
  const common = (event: KeyboardEvent<HTMLInputElement>): boolean => {
    const mod = props.mac ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finder.close();
      return true;
    }
    const option = optionKeys[event.code];
    if (event.altKey && !mod && option) {
      event.preventDefault();
      finder.toggle(option);
      return true;
    }
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      finder.step(event.shiftKey ? -1 : 1);
      return true;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      if (event.altKey) {
        finder.toggleReplace();
        if (!finder.replacing) requestAnimationFrame(() => replaceInput.current?.focus());
      } else input.current?.select();
      return true;
    }
    return false;
  };

  return (
    <div
      role="search"
      aria-label="Find in file"
      className="ace-floating-solid absolute top-1 right-4 z-10 flex w-[min(30rem,calc(100%-2rem))] flex-col rounded-lg p-0.5"
    >
      <div className="flex h-8 items-center gap-0.5">
        <IconButton
          icon={finder.replacing ? CaretDownIcon : CaretRightIcon}
          label={finder.replacing ? "Hide replace" : "Show replace"}
          size="sm"
          className="size-7"
          aria-expanded={finder.replacing}
          onClick={finder.toggleReplace}
        />
        <input
          ref={input}
          aria-label="Find in file"
          placeholder="Find"
          value={finder.query}
          spellCheck={false}
          onChange={(event) => finder.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (common(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              finder.step(event.shiftKey ? -1 : 1);
            }
          }}
          className={field}
        />
        <Toggle label="Match case" option="caseSensitive" finder={finder}>
          Aa
        </Toggle>
        <Toggle label="Match whole word" option="wholeWord" finder={finder}>
          ab
        </Toggle>
        <Toggle label="Use regular expression" option="regex" finder={finder}>
          .*
        </Toggle>
        <span
          aria-live="polite"
          className="shrink-0 px-1 text-right text-xs whitespace-nowrap text-subtle-foreground tabular-nums"
        >
          {finder.query ? countText(finder) : ""}
        </span>
        <IconButton
          icon={CaretUpIcon}
          label="Previous match"
          keys="shift+enter"
          size="sm"
          className="size-7"
          disabled={!canStep}
          onClick={() => finder.step(-1)}
        />
        <IconButton
          icon={CaretDownIcon}
          label="Next match"
          keys="enter"
          size="sm"
          className="size-7"
          disabled={!canStep}
          onClick={() => finder.step(1)}
        />
        <Toggle label="Find in selection" option="inSelection" finder={finder}>
          ≡
        </Toggle>
        <IconButton
          icon={XIcon}
          label="Close find"
          keys="escape"
          size="sm"
          className="size-7"
          onClick={finder.close}
        />
      </div>
      {finder.replacing ? (
        <div className="flex h-8 items-center gap-0.5 pr-0.5 pl-7.5">
          <input
            ref={replaceInput}
            aria-label="Replace with"
            placeholder="Replace"
            value={finder.replacement}
            spellCheck={false}
            onChange={(event) => finder.setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (common(event)) return;
              if (event.key === "Enter") {
                event.preventDefault();
                const all = props.mac ? event.metaKey : event.ctrlKey;
                if (all) finder.replaceAll();
                else finder.replaceOne();
              }
            }}
            className={field}
          />
          <Button size="xs" variant="ghost" disabled={!canStep} onClick={finder.replaceOne}>
            Replace
          </Button>
          <Button size="xs" variant="ghost" disabled={!canStep} onClick={finder.replaceAll}>
            Replace all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** "3 of 12", "12 found" before stepping onto one, or why there are none. */
function countText(finder: FindInFile): string {
  if (finder.status === "invalid") return "Invalid pattern";
  if (finder.status === "pending") return "Searching...";
  if (finder.status !== "ready") return "";
  const count = finder.matches.length;
  if (!count) return "No results";
  const total = count >= matchLimit ? `${matchLimit}+` : String(count);
  return finder.index < 0 ? `${total} found` : `${finder.index + 1} of ${total}`;
}

function Toggle(props: {
  label: string;
  option: FindOption;
  finder: FindInFile;
  children: string;
}) {
  const { finder, option } = props;
  const pressed = option === "inSelection" ? finder.scope !== undefined : finder[option];
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={pressed}
      onClick={() => finder.toggle(option)}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-sm font-mono text-xs focus-ring",
        pressed
          ? "bg-accent text-foreground"
          : "text-subtle-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
