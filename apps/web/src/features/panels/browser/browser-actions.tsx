import {
  ArrowSquareOutIcon,
  BroomIcon,
  CameraIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  CopyIcon,
  DevicesIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileCodeIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PrinterIcon,
  PuzzlePieceIcon,
  RecordIcon,
  ShieldSlashIcon,
  StopCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { openExternal, revealer } from "@/boot/open-external.ts";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useLocal } from "../store.ts";
import type { BrowserTabView } from "../sources.ts";
import { roundButton } from "./page-toolbar.tsx";
import { recordingThreads, type BrowserFeatures } from "./use-browser-features.ts";
import { extensionsHidden } from "./extensions-menu.tsx";
import { useAlwaysShowDevices } from "./device-settings.ts";
import type { PageActions } from "./use-page-actions.ts";
import type { PageTools } from "./use-page-tools.ts";
import { ZoomRow } from "./zoom-controls.tsx";
import { AskAgentItem } from "./ask-agent-item.tsx";

const icon = (glyph: typeof CopyIcon) => <Icon icon={glyph} />;

/**
 * The page's ⋯ menu, grouped as a browser's: Find, Print, Zoom, the device toolbar and a
 * screenshot; Downloads, History and clearing data; the developer tools; the tab's own choices
 * (keep agents out, record, copy or open the address); Browser settings and Close tab.
 * Everything acts on the tab the person views.
 */
export function BrowserActions(props: {
  threadId: string;
  /** The tab the person views; undefined before the thread has a browser. */
  tab: BrowserTabView | undefined;
  shownUrl: string | undefined;
  external: string | undefined;
  online: boolean;
  browser: BrowserFeatures;
  tools: PageTools;
  actions: PageActions;
  onFind(): void;
  onDownloads(): void;
  onHistory(): void;
  onClearData(): void;
  onSettings(): void;
  onKeepPrivate(value: boolean): void;
  onCloseTab(): void;
}) {
  const toast = useToast();
  const { shownUrl, external, browser, tab, tools, actions } = props;
  const recording = useLocal(recordingThreads, (threads) => threads.has(props.threadId));
  const hidden = useLocal(extensionsHidden, (value) => value);
  const [always, setAlways] = useAlwaysShowDevices();
  const live = tab !== undefined;
  const usable = live && props.online;
  const privately = tab?.private === true;
  const noPage = live ? undefined : "No page is open";
  const setRecording = (on: boolean) =>
    recordingThreads.set((threads) => {
      const next = new Set(threads);
      if (on) next.add(props.threadId);
      else next.delete(props.threadId);
      return next;
    });
  const toggleRecording = async () => {
    if (!recording) {
      if (await browser.startRecording()) setRecording(true);
      return;
    }
    const artifact = await browser.stopRecording();
    setRecording(false);
    if (!artifact) return;
    const reveal = revealer();
    toast.add({
      title: "Recording saved to this thread",
      description: artifact.filename ?? artifact.path,
      ...(reveal
        ? {
            actionProps: {
              children: "Show in Finder",
              onClick: () => void reveal(artifact.path).catch(() => {}),
            },
          }
        : {}),
    });
  };
  const openOutside = () =>
    external &&
    void openExternal(external).catch((error: unknown) =>
      toast.error({
        title: "Couldn't open the page",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  const pageTool = usable && actions.available;
  return (
    <Menu>
      <MenuTrigger
        aria-label="Browser options"
        className={cn(
          roundButton,
          "grid place-items-center text-muted-foreground outline-none focus-ring hover:text-foreground aria-expanded:bg-foreground/10 aria-expanded:text-foreground",
        )}
      >
        <DotsThreeIcon aria-hidden size={16} weight="bold" />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-64">
        <MenuItem
          icon={icon(MagnifyingGlassIcon)}
          keys="mod+f"
          resolve={false}
          disabled={!usable}
          onClick={props.onFind}
        >
          Find in page
        </MenuItem>
        <MenuItem
          icon={icon(PrinterIcon)}
          keys="mod+p"
          resolve={false}
          disabled={!pageTool}
          onClick={actions.print}
        >
          Print…
        </MenuItem>
        <ZoomRow tools={tools} />
        <MenuSub>
          <MenuSubTrigger icon={icon(DevicesIcon)} disabled={!usable || !tools.supported}>
            Device toolbar
          </MenuSubTrigger>
          <MenuContent side="inline-start" align="start" sideOffset={4}>
            <MenuCheckboxItem
              checked={tools.toolbar}
              onCheckedChange={(checked) => tools.showToolbar(checked)}
            >
              Show device toolbar
            </MenuCheckboxItem>
            <MenuCheckboxItem checked={always} onCheckedChange={(checked) => setAlways(checked)}>
              Always show in new tabs
            </MenuCheckboxItem>
          </MenuContent>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger icon={icon(CameraIcon)} disabled={!pageTool}>
            Take a screenshot
          </MenuSubTrigger>
          <MenuContent side="inline-start" align="start" sideOffset={4}>
            <MenuItem onClick={() => actions.screenshot(false)}>Visible area</MenuItem>
            <MenuItem onClick={() => actions.screenshot(true)}>Full page</MenuItem>
          </MenuContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem icon={icon(DownloadSimpleIcon)} disabled={!live} onClick={props.onDownloads}>
          Downloads
        </MenuItem>
        <MenuItem
          icon={icon(ClockCounterClockwiseIcon)}
          keys="mod+y"
          resolve={false}
          onClick={props.onHistory}
        >
          History
        </MenuItem>
        <MenuItem icon={icon(BroomIcon)} disabled={!pageTool} onClick={props.onClearData}>
          Clear browsing data…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={icon(CodeIcon)}
          keys="mod+alt+i"
          resolve={false}
          disabled={!usable || actions.devtoolsReason !== undefined}
          reason={live ? actions.devtoolsReason : undefined}
          onClick={() => actions.devtools()}
        >
          Developer tools
        </MenuItem>
        <MenuItem
          icon={icon(FileCodeIcon)}
          keys="mod+alt+u"
          resolve={false}
          disabled={!pageTool}
          onClick={actions.viewSource}
        >
          View page source
        </MenuItem>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={privately}
          disabled={!usable}
          onCheckedChange={(checked) => props.onKeepPrivate(checked)}
        >
          <span className="flex items-center gap-[9px]">
            <Icon icon={ShieldSlashIcon} />
            Keep agents out of this tab
          </span>
        </MenuCheckboxItem>
        <MenuItem
          icon={icon(recording ? StopCircleIcon : RecordIcon)}
          disabled={!usable || (privately && !recording)}
          reason={
            privately && !recording ? "Tabs agents are kept out of are never recorded" : noPage
          }
          onClick={() => void toggleRecording()}
        >
          {recording ? "Stop recording" : "Record the page"}
        </MenuItem>
        <MenuItem
          icon={icon(CopyIcon)}
          disabled={!shownUrl}
          onClick={() =>
            shownUrl &&
            void navigator.clipboard?.writeText(shownUrl).then(
              () => toast.add({ title: "Address copied" }),
              () => toast.error({ title: "Couldn't copy the address" }),
            )
          }
        >
          Copy address
        </MenuItem>
        <MenuItem icon={icon(ArrowSquareOutIcon)} disabled={!external} onClick={openOutside}>
          Open in your browser
        </MenuItem>
        <AskAgentItem threadId={props.threadId} tab={tab} />
        {hidden && (
          <MenuItem icon={icon(PuzzlePieceIcon)} onClick={() => extensionsHidden.set(() => false)}>
            Show extensions in the toolbar
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={icon(GearSixIcon)} onClick={props.onSettings}>
          Browser settings
        </MenuItem>
        <MenuItem
          danger
          icon={icon(XCircleIcon)}
          disabled={!usable}
          reason={noPage}
          onClick={props.onCloseTab}
        >
          Close tab
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
