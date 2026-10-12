import { useMemo, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { keymap } from "@/lib/keymap.ts";
import {
  useWorkspaceActions,
  useWorkspaceStore,
  type OpenTab,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
const heading = "px-1 text-xs font-medium text-muted-foreground";
const card =
  "focus-ring group/card relative flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-3 text-left text-ui text-foreground transition-colors duration-(--motion-fast) hover:bg-accent";

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

/**
 * The new tab is a catalog of tools. Picking one replaces the launcher with that tool.
 */
export function LauncherTab(props: TabViewProps) {
  const store = useWorkspaceStore();
  const definition = store.definition(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const grid = useToolGrid();
  const tools = useMemo(
    () =>
      (definition?.kinds() ?? [])
        .filter((kind) => kind.launcher !== undefined)
        .toSorted((a, b) => (a.launcher ?? 0) - (b.launcher ?? 0)),
    [definition],
  );
  /** Open a request in this tab's place. */
  const openHere = (request: OpenTab) => actions.replace(props.tab.key, request);
  return (
    <div className="@container flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-10 pb-12">
          <h2 className={heading}>Tools</h2>
          <ul aria-label="Tools" onKeyDown={grid.onKeyDown} className="mt-2 flex flex-col gap-px">
            {tools.map((kind, index) => {
              const keys = definition?.shortcut(kind.kind);
              return (
                <li key={kind.kind} className="relative min-w-0">
                  <Tip label={kind.label} {...(keys ? { keys: keymap[keys].keys } : {})}>
                    <button
                      type="button"
                      data-tool
                      tabIndex={grid.active === index ? 0 : -1}
                      onFocus={() => {
                        grid.setActive(index);
                        kind.preload();
                      }}
                      className={card}
                      onPointerEnter={kind.preload}
                      onClick={() => openHere({ kind: kind.kind })}
                    >
                      <Icon icon={kind.icon} size={16} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{kind.label}</span>
                      {kind.unavailable ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {kind.unavailable}
                        </span>
                      ) : null}
                    </button>
                  </Tip>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
