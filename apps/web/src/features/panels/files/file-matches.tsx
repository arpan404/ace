import { FolderIcon } from "@ace/icons";
import { cleanPath, fuzzyPositions, pathParts } from "@ace/ui-core";
import { useEffect } from "react";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { cn } from "@/lib/cn.ts";
import { FileRowMenu } from "./file-menu.tsx";
import { FileRowItems } from "./file-row-items.tsx";
import { MiddleName, MiddleText } from "./middle-name.tsx";
import type { OpenHow, TreeCommands } from "./tree-commands.ts";

/** The id of the match at `index`, for the filter field's `aria-activedescendant`. */
export const matchId = (list: string, index: number) => `${list}-${index}`;

/** What the filter's matches say about a path: its name, its folder and the whole path. */
function described(path: string) {
  const clean = cleanPath(path);
  const { name, folder } = pathParts(clean);
  return { clean, name, folder, label: folder ? `${name}, ${folder}` : name };
}

/**
 * The explorer filter's results (problem 1 of the explorer polish): one flat list, best first as
 * ranked, each row the name (the matched letters in full weight) and then its folder in subtle
 * ink, both cut in the middle so the name stays readable at any width. The filter field keeps
 * the keyboard: its arrows move `active` and Enter opens it, so the rows are options of a
 * listbox rather than tab stops. A click glances at a file; a double-click keeps it.
 */
export function FileMatches(props: {
  id: string;
  query: string;
  paths: readonly string[];
  active: number;
  current: string | undefined;
  onActive(index: number): void;
  onOpen(path: string, how: OpenHow): void;
  /** A folder found by the filter: show it in the tree. */
  onFolder(path: string): void;
  commands: TreeCommands;
}) {
  const { active } = props;
  // The highlighted match stays in view as the arrows move through a long list.
  useEffect(() => {
    document.getElementById(matchId(props.id, active))?.scrollIntoView?.({ block: "nearest" });
  }, [props.id, active]);
  return (
    <div
      id={props.id}
      role="listbox"
      aria-label="Matching files"
      data-part="file-matches"
      className="flex flex-col"
    >
      {props.paths.map((path, index) => {
        const folder = path.endsWith("/");
        const { clean, name, folder: parent, label } = described(path);
        const positions = fuzzyPositions(props.query.trim(), clean) ?? [];
        const activate = (how: OpenHow) =>
          folder ? props.onFolder(clean) : props.onOpen(clean, how);
        return (
          <FileRowMenu
            key={path}
            name={name}
            tabbable={false}
            items={<FileRowItems entry={{ path: clean, folder }} commands={props.commands} />}
          >
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the filter field's arrows and Enter pick through aria-activedescendant */}
            <div
              id={matchId(props.id, index)}
              role="option"
              aria-selected={index === active}
              aria-label={label}
              tabIndex={-1}
              title={clean}
              data-path={path}
              data-state={clean === props.current ? "selected" : undefined}
              onPointerMove={() => index !== active && props.onActive(index)}
              onClick={(event) => activate(event.altKey ? "side" : "preview")}
              onDoubleClick={() => !folder && activate("keep")}
              onMouseDown={(event) => event.button === 1 && event.preventDefault()}
              onAuxClick={(event) => {
                if (event.button !== 1 || folder) return;
                event.preventDefault();
                activate("side");
              }}
              className={cn(
                "flex h-8 w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm pr-2 pl-2 text-ui select-none group-hover/file:pr-8",
                index === active ? "bg-active" : "hover:bg-hover",
              )}
            >
              <Icon
                icon={folder ? FolderIcon : fileIcon(clean)}
                size={14}
                className="shrink-0 text-subtle-foreground"
              />
              <MiddleName
                part="match-name"
                text={name}
                offset={clean.length - name.length}
                positions={positions}
                className="text-foreground"
              />
              {parent && (
                <MiddleText
                  part="match-folder"
                  text={parent}
                  tail={16}
                  className="shrink-[999] text-xs text-subtle-foreground"
                />
              )}
            </div>
          </FileRowMenu>
        );
      })}
    </div>
  );
}
