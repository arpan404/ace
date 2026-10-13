import { useMemo } from "react";
import {
  useWorkspaceActions,
  useWorkspaceStore,
  type OpenRequest,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { useVisited } from "../browser/browser-state.ts";
import { PageNav, PageToolbar } from "../browser/page-toolbar.tsx";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { Suggested } from "./suggested.tsx";
import { ToolGrid } from "./tool-grid.tsx";
import { useSuggested, type SuggestedSite } from "./use-suggested.ts";

const fresh = "a new tab has no history";

/** The Suggested row, once the panel services (the thread's dev servers) have loaded. */
function SuggestedSites(props: {
  scope: string;
  openHere(request: OpenRequest): void;
  openAddress(url: string): void;
}) {
  const { preview } = usePanelServices();
  const sites = useSuggested(preview, props.scope);
  const open = (site: SuggestedSite) => {
    if (site.port === undefined || !preview.canForward()) return props.openAddress(site.url);
    // A dev server opens in Preview, through the daemon's gateway, so any device can see it.
    void preview.forward(props.scope, site.port).then(
      () => props.openHere({ kind: "preview" }),
      () => props.openAddress(site.url),
    );
  };
  return <Suggested sites={sites} onOpen={open} />;
}

/**
 * The new tab, as a browser's: the page toolbar with an address that opens the Browser, the
 * tools as cards, and the sites this thread suggests (its dev servers, then pages it visited).
 * Whatever is picked takes this tab's place.
 */
export function LauncherTab(props: TabViewProps) {
  const store = useWorkspaceStore();
  const definition = store.definition(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const visited = useVisited(props.scope);
  const kinds = useMemo(() => definition?.kinds() ?? [], [definition]);
  const tools = useMemo(
    () =>
      kinds
        .filter((kind) => kind.launcher !== undefined)
        .toSorted((a, b) => (a.launcher ?? 0) - (b.launcher ?? 0)),
    [kinds],
  );
  const openHere = (request: OpenRequest) => actions.replace(props.tab.key, request);
  const openAddress = (url: string) => {
    const browser = kinds.find((kind) => kind.fromUrl);
    const request = browser?.fromUrl?.(url, store.get(props.scope));
    if (request) openHere(request);
  };
  const known = visited.map((url) => ({
    url,
    label: url.replace(/^https?:\/\//, ""),
    detail: "Visited",
  }));
  return (
    <div className="@container flex h-full flex-col">
      <PageToolbar
        nav={
          <PageNav
            back={{ reason: fresh }}
            forward={{ reason: fresh }}
            reload={{ reason: fresh }}
          />
        }
        address={
          <AddressBar
            url={undefined}
            known={known}
            loading={false}
            placeholder="Search or enter a URL"
            onGo={openAddress}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 pt-8 pb-12">
          <h2 className="px-1 text-sm font-medium text-foreground">Tools</h2>
          <ToolGrid
            scope={props.scope}
            tools={tools}
            definition={definition}
            actions={actions}
            onPick={(kind) => openHere({ kind: kind.kind })}
          />
          <WithServices quiet>
            <SuggestedSites scope={props.scope} openHere={openHere} openAddress={openAddress} />
          </WithServices>
        </div>
      </div>
    </div>
  );
}
