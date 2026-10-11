import {
  ArrowSquareOutIcon,
  CopyIcon,
  DetectiveIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openExternal, revealer } from "@/boot/open-external.ts";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuGroup,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Icon } from "@/components/icon.tsx";
import { useLocal } from "../store.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";
import { DownloadsButton } from "./downloads.tsx";
import { recordingThreads, type BrowserFeatures } from "./use-browser-features.ts";
import { viewportById, viewports } from "./viewports.ts";

const icon = (glyph: typeof PlusIcon) => <Icon icon={glyph} />;

export function BrowserActions(props: {
  source: PreviewSource;
  threadId: string;
  shownUrl: string | undefined;
  external: string | undefined;
  viewport: ReturnType<typeof viewportById>;
  onViewport(id: string): void;
  live: boolean;
  online: boolean;
  backend: BrowserView["backend"] | undefined;
  browser: BrowserFeatures;
  onFind(): void;
  downloads: NonNullable<BrowserView["downloads"]>;
  privately: boolean;
  /** Make private, when the page can be made private from here. */
  onPrivate?: (() => void) | undefined;
}) {
  const toast = useToast();
  const { shownUrl, external, viewport, browser } = props;
  const recording = useLocal(recordingThreads, (threads) => threads.has(props.threadId));
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
      toast.add({
        title: "Couldn't open the page",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  return (
    <>
      <DownloadsButton downloads={props.downloads} />
      <Menu>
        <MenuTrigger
          aria-label="Browser options"
          className="grid size-7 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-ring aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <DotsThreeIcon aria-hidden size={16} weight="bold" />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            icon={icon(MagnifyingGlassIcon)}
            keys="mod+f"
            resolve={false}
            disabled={!props.live || !props.online}
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
                () => toast.add({ title: "Couldn't copy the address" }),
              )
            }
          >
            Copy address
          </MenuItem>
          <MenuItem icon={icon(ArrowSquareOutIcon)} disabled={!external} onClick={openOutside}>
            Open in your browser
          </MenuItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuLabel>Page size</MenuLabel>
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
          </MenuGroup>
          <MenuSeparator />
          {props.onPrivate && (
            <MenuItem icon={icon(DetectiveIcon)} onClick={props.onPrivate}>
              Make private
            </MenuItem>
          )}
          <MenuItem
            disabled={!props.live || !props.online || (props.privately && !recording)}
            reason={
              props.privately && !recording
                ? "Private pages are never recorded"
                : props.live
                  ? undefined
                  : "No page is open"
            }
            onClick={() => void toggleRecording()}
          >
            {recording ? "Stop recording" : "Record the page"}
          </MenuItem>
          <MenuItem
            danger
            disabled={!props.live || !props.online}
            reason={props.live ? undefined : "No page is open"}
            onClick={() => void props.source.close(props.threadId).catch(() => undefined)}
          >
            Close the thread's page
          </MenuItem>
          <MenuSeparator />
          <p className="px-2.5 py-1.5 text-xs leading-4 text-subtle-foreground">
            {props.backend === "embedded"
              ? "Runs in the ace desktop app's browser."
              : props.backend === "headless"
                ? "Runs in ace's own Chromium on this machine."
                : "Pages open in ace's own browser, never your personal one."}
          </p>
        </MenuContent>
      </Menu>
    </>
  );
}
