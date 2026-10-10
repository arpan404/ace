import { useId, useState, useRef, useLayoutEffect, type KeyboardEvent } from "react";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  LinkIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import type { AddTab } from "./requests.ts";

const sources = [
  {
    tab: "open",
    name: "Local folder",
    description: "Browse a folder on your machine",
    icon: FolderOpenIcon,
  },
  {
    tab: "clone",
    name: "Git URL",
    description: "Clone a repository using your Git credentials",
    icon: LinkIcon,
  },
  {
    tab: "create",
    name: "New project",
    description: "Create a folder and an optional Git repository",
    icon: FolderPlusIcon,
  },
] as const;

/** One source choice before showing only that source's required inputs. */
export function ProjectSourcePicker(props: { onChoose(tab: AddTab): void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  const rows = sources.filter((source) =>
    `${source.name} ${source.description}`.toLowerCase().includes(text.toLowerCase()),
  );
  const current = Math.min(active, Math.max(0, rows.length - 1));
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") setActive(rows.length ? (current + 1) % rows.length : 0);
    else if (event.key === "ArrowUp")
      setActive(rows.length ? (current + rows.length - 1) % rows.length : 0);
    else if (event.key === "Enter" && rows[current]) props.onChoose(rows[current].tab);
    else return;
    event.preventDefault();
  };
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex h-11 items-center gap-2 border-b border-border pb-3">
        <Icon icon={MagnifyingGlassIcon} size={18} className="text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Search project sources"
          aria-expanded
          aria-controls={id}
          aria-activedescendant={rows[current] ? `${id}-${current}` : undefined}
          value={text}
          placeholder="Search sources…"
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={keyDown}
          ref={input}
          className="h-full min-w-0 flex-1 rounded-[8px] bg-input text-ui outline-none"
        />
      </div>
      <div id={id} role="listbox" aria-label="Project sources" className="grid gap-1">
        {rows.map((source, at) => (
          <button
            type="button"
            key={source.tab}
            id={`${id}-${at}`}
            role="option"
            aria-label={source.name}
            aria-selected={at === current}
            onPointerMove={() => setActive(at)}
            onClick={() => props.onChoose(source.tab)}
            className="flex w-full items-center gap-3 h-11 rounded-[8px] px-2 text-left focus-ring aria-selected:bg-accent"
          >
            <Icon icon={source.icon} size={20} className="shrink-0 text-muted-foreground" />
            <span className="grid gap-1">
              <span className="text-ui font-medium">{source.name}</span>
              <span className="text-sm text-muted-foreground">{source.description}</span>
            </span>
          </button>
        ))}
        {!rows.length && (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            No sources match your search.
          </p>
        )}
      </div>
    </div>
  );
}
