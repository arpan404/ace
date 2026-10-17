import {
  ArrowSquareOutIcon,
  CopyIcon,
  DevicesIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
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
  MenuRadioGroup,
  MenuRadioItem,
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
import { viewportById, viewports } from "./viewports.ts";

const icon = (glyph: typeof PlusIcon) => <Icon icon={glyph} />;

/**
 * The page's ⋯ menu: Find, Copy address, Open in your browser, Page size, Keep agents out of
 * this tab, Record the page and Close tab. Everything acts on the tab the person views.
 */
export function BrowserActions(props: {
  threadId: string;
  /** The tab the person views; undefined before the thread has a browser. */
  tab: BrowserTabView | undefined;
  shownUrl: string | undefined;
  external: string | undefined;
  viewport: ReturnType<typeof viewportById>;
  onViewport(id: string): void;
  online: boolean;
  browser: BrowserFeatures;
  onFind(): void;
  onKeepPrivate(value: boolean): void;
  onCloseTab(): void;
}) {
  const toast = useToast();
  const { shownUrl, external, viewport, browser, tab } = props;
  const recording = useLocal(recordingThreads, (threads) => threads.has(props.threadId));
  const hidden = useLocal(extensionsHidden, (value) => value);
  const live = tab !== undefined;
  const privately = tab?.private === true;
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
      <MenuContent align="end">
        <MenuItem
          icon={icon(MagnifyingGlassIcon)}
          keys="mod+f"
          resolve={false}
          disabled={!live || !props.online}
          onClick={props.onFind}
        >
          Find in page
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
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger icon={icon(DevicesIcon)}>Page size</MenuSubTrigger>
          <MenuContent side="inline-start" align="start" sideOffset={4}>
            <MenuRadioGroup
              value={viewport.id}
              onValueChange={(value) => props.onViewport(String(value))}
            >
              {viewports.map((each) => (
                <MenuRadioItem closeOnClick key={each.id} value={each.id}>
                  {each.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </MenuSub>
        <MenuCheckboxItem
          checked={privately}
          disabled={!live || !props.online}
          onCheckedChange={(checked) => props.onKeepPrivate(checked)}
        >
          <span className="flex items-center gap-2">
            <Icon icon={ShieldSlashIcon} />
            Keep agents out of this tab
          </span>
        </MenuCheckboxItem>
        <MenuItem
          icon={icon(recording ? StopCircleIcon : RecordIcon)}
          disabled={!live || !props.online || (privately && !recording)}
          reason={
            privately && !recording
              ? "Tabs agents are kept out of are never recorded"
              : live
                ? undefined
                : "No page is open"
          }
          onClick={() => void toggleRecording()}
        >
          {recording ? "Stop recording" : "Record the page"}
        </MenuItem>
        {hidden && (
          <MenuItem icon={icon(PuzzlePieceIcon)} onClick={() => extensionsHidden.set(() => false)}>
            Show extensions in the toolbar
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          danger
          icon={icon(XCircleIcon)}
          disabled={!live || !props.online}
          reason={live ? undefined : "No page is open"}
          onClick={props.onCloseTab}
        >
          Close tab
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
