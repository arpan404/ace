import { ArrowUpRightIcon, DotsThreeIcon, FileTextIcon, GlobeIcon } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import {
  useWorkspaceActions,
  useWorkspaceStore,
  type OpenTab,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { PageNav, PageToolbar, toolbarButton } from "../browser/page-toolbar.tsx";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import type { PreviewSource } from "../sources.ts";
import { useLoadedServices, usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import {
  fileSuggestions,
  urlSuggestions,
  type FileSuggestion,
  type UrlSuggestion,
} from "./suggestions.ts";

const heading = "px-1 text-xs font-medium text-muted-foreground";
const card =
  "focus-ring group/card relative flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-ui text-foreground transition-colors duration-(--dur-1) bg-foreground/3 hover:bg-accent";

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
 * The new tab: a catalog of the workspace's tools, then what this thread suggests opening (its
 * local addresses and recently edited files). Picking one turns this tab into it; nothing here
 * starts agent work.
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
  const kindFor = (claim: "fromFile" | "fromUrl") => tools.find((kind) => kind[claim]);
  const openUrl = (url: string) => {
    const kind = kindFor("fromUrl");
    if (kind?.fromUrl) openHere(kind.fromUrl(url, store.get(props.scope)));
  };
  return (
    <div className="@container flex h-full flex-col">
      {kindFor("fromUrl") && <LauncherAddress threadId={props.scope} onGo={openUrl} />}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-10 pb-12">
          <h2 className={heading}>Tools</h2>
          <ul
            aria-label="Tools"
            onKeyDown={grid.onKeyDown}
            className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 @min-[30rem]:grid-cols-2"
          >
            {tools.map((kind, index) => {
              const keys = definition?.shortcut(kind.kind);
              return (
                <li key={kind.kind} className="relative min-w-0">
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
                    ) : (
                      keys && <Kbd keys={keymap[keys].keys} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <WithServices quiet>
            <Suggested
              threadId={props.scope}
              onFile={(file) => {
                const kind = kindFor("fromFile");
                if (kind?.fromFile) openHere(kind.fromFile(file.path));
              }}
              onUrl={(url) => openUrl(url.url)}
            />
          </WithServices>
        </div>
      </div>
    </div>
  );
}

/** Why a new tab's page controls are off: there is no page yet. */
const noPage = "open a page first";

/**
 * The new tab's toolbar: the browser page's own, shape for shape, so it doesn't move when the
 * tab becomes a page. An address opens the Browser in this tab's place; it suggests the
 * thread's dev servers once the panel services have loaded.
 */
function LauncherAddress(props: { threadId: string; onGo(url: string): void }) {
  const services = useLoadedServices();
  const bar = (known: readonly UrlSuggestion[]) => (
    <PageToolbar
      nav={
        <PageNav
          back={{ reason: noPage }}
          forward={{ reason: noPage }}
          reload={{ reason: noPage }}
        />
      }
      address={
        <AddressBar
          url={undefined}
          known={known.map((each) => ({ url: each.url, label: each.label, detail: each.detail }))}
          loading={false}
          autoFocus
          onGo={props.onGo}
        />
      }
      actions={
        <>
          <IconButton
            icon={DotsThreeIcon}
            label={`Browser options · ${noPage}`}
            disabled
            focusableWhenDisabled
            className={toolbarButton}
          />
        </>
      }
    />
  );
  if (!services) return bar([]);
  return <KnownAddresses source={services.preview} threadId={props.threadId} render={bar} />;
}

function KnownAddresses(props: {
  source: PreviewSource;
  threadId: string;
  render(known: readonly UrlSuggestion[]): React.ReactNode;
}) {
  return props.render(usePreviewSuggestions(props.source, props.threadId));
}

function usePreviewSuggestions(source: PreviewSource, threadId: string): UrlSuggestion[] {
  // The source's reads change with its version; read them again on each one.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Find the thread's dev servers while the launcher shows.
  useEffect(() => source.watch(threadId), [source, threadId]);
  return urlSuggestions(source.view(threadId), source.servers(threadId));
}

function Suggested(props: {
  threadId: string;
  onFile(file: FileSuggestion): void;
  onUrl(url: UrlSuggestion): void;
}) {
  const { preview } = usePanelServices();
  const urls = usePreviewSuggestions(preview, props.threadId);
  const turns = useTurns(props.threadId);
  const files = useMemo(() => fileSuggestions(turns), [turns]);
  return (
    <section aria-labelledby="launcher-suggested" className="mt-8">
      <h2 id="launcher-suggested" className={heading}>
        Suggested
      </h2>
      {!urls.length && !files.length ? (
        <p className="mt-2 px-1 text-ui leading-normal text-muted-foreground">
          Nothing yet. Dev servers this thread starts and files its agents edit show up here.
        </p>
      ) : (
        <ul aria-label="Suggested" className="mt-2 flex flex-col gap-0.5">
          {urls.map((url) => (
            <SuggestionRow
              key={url.url}
              icon={GlobeIcon}
              title={url.label}
              detail={url.detail}
              onClick={() => props.onUrl(url)}
            />
          ))}
          {files.map((file) => (
            <SuggestionRow
              key={file.path}
              icon={FileTextIcon}
              title={file.name}
              detail={file.folder || "Project root"}
              mono
              onClick={() => props.onFile(file)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionRow(props: {
  icon: typeof GlobeIcon;
  title: string;
  detail: string;
  mono?: boolean;
  onClick(): void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        className="focus-ring flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-ui transition-colors duration-(--dur-1) hover:bg-accent"
      >
        <Icon icon={props.icon} size={16} className="text-muted-foreground" />
        <span
          className={cn("shrink-0 truncate text-foreground", props.mono && "font-mono text-sm")}
        >
          {props.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {props.detail}
        </span>
      </button>
    </li>
  );
}
