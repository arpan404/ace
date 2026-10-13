import { ArrowSquareOutIcon, DotsThreeIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import type { TabKind, WorkspaceActions, WorkspaceDefinition } from "@/lib/workspace/index.ts";

const card = cn(
  "focus-ring flex h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-border px-3 text-left text-ui text-foreground",
  "transition-colors duration-(--motion-fast) hover:bg-fill",
);

/**
 * The Tools grid is one Tab stop: arrows move by its columns (two, or one below 30rem), Home
 * and End jump, Enter opens.
 */
function useToolGrid() {
  const [active, setActive] = useState(0);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const cards = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > li > [data-tool]"),
    ];
    const at = cards.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const [first, second] = cards;
    const columns = first && second && first.offsetTop === second.offsetTop ? 2 : 1;
    const last = cards.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      ArrowDown: at + columns,
      ArrowUp: at - columns,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const to = Math.max(0, Math.min(last, next));
    setActive(to);
    cards[to]?.focus();
  };
  return { active, setActive, onKeyDown };
}

/** What a tool's ⋯ offers: its shortcut's own action, and a tab of its own beside this one. */
function toolOptions(props: {
  kind: TabKind;
  scope: string;
  actions: WorkspaceActions;
  label: string | undefined;
}) {
  const { kind, scope, actions } = props;
  return [
    ...(kind.onShortcut
      ? [
          {
            id: "shortcut",
            label: props.label ?? kind.label,
            icon: MagnifyingGlassIcon,
            run: () => kind.onShortcut?.(scope),
          },
        ]
      : []),
    ...(kind.singleton
      ? []
      : [
          {
            id: "beside",
            label: "Open in a new tab",
            icon: ArrowSquareOutIcon,
            run: () => actions.open({ kind: kind.kind }),
          },
        ]),
  ];
}

/**
 * The new tab's Tools: bordered cards in two columns (one below 30rem), each with its icon, name,
 * shortcut and, where the tool has options, a ⋯ menu. Picking a card puts the tool in this
 * tab's place.
 */
export function ToolGrid(props: {
  scope: string;
  tools: readonly TabKind[];
  definition: WorkspaceDefinition | undefined;
  actions: WorkspaceActions;
  onPick(kind: TabKind): void;
}) {
  const grid = useToolGrid();
  return (
    <ul
      aria-label="Tools"
      onKeyDown={grid.onKeyDown}
      className="mt-3 grid grid-cols-2 gap-2 @max-[30rem]:grid-cols-1"
    >
      {props.tools.map((kind, index) => {
        const keys = props.definition?.shortcut(kind.kind);
        const options = toolOptions({
          kind,
          scope: props.scope,
          actions: props.actions,
          label: keys ? keymap[keys].label : undefined,
        });
        return (
          <li key={kind.kind} className="relative min-w-0">
            <button
              type="button"
              data-tool
              aria-keyshortcuts={keys ? keymap[keys].keys : undefined}
              tabIndex={grid.active === index ? 0 : -1}
              onFocus={() => {
                grid.setActive(index);
                kind.preload();
              }}
              className={cn(card, options.length > 0 && "pr-11")}
              onPointerEnter={kind.preload}
              onClick={() => props.onPick(kind)}
            >
              <Icon icon={kind.icon} size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{kind.label}</span>
              {kind.unavailable ? (
                <span className="shrink-0 text-xs text-muted-foreground">{kind.unavailable}</span>
              ) : (
                keys && <Kbd shortcut={keys} className="shrink-0" />
              )}
            </button>
            {options.length > 0 && (
              <Menu>
                <MenuTrigger
                  aria-label={`More for ${kind.label}`}
                  className="focus-ring absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
                >
                  <DotsThreeIcon aria-hidden size={16} weight="bold" />
                </MenuTrigger>
                <MenuContent align="end">
                  {options.map((option) => (
                    <MenuItem
                      key={option.id}
                      icon={<Icon icon={option.icon} />}
                      onClick={option.run}
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </li>
        );
      })}
    </ul>
  );
}
