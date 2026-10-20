import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ClipboardTextIcon,
  CodeIcon,
  CopyIcon,
  CursorClickIcon,
  DownloadSimpleIcon,
  FileCodeIcon,
  ImageIcon,
  LinkIcon,
  PlusSquareIcon,
} from "@phosphor-icons/react";
import type { ReactElement } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";

/** What a right click landed on: the link it is in and the image it is. */
export interface PageTarget {
  link?: string | undefined;
  image?: string | undefined;
}

/** What the page's right-click menu offers, and whether each can run now. */
export interface PageMenu {
  /** What is under the pointer, once the page has said (undefined while it is asked). */
  target: PageTarget | undefined;
  /** A right click at this page point: find what is under it. */
  locate(point: { x: number; y: number }): void;
  openLink(url: string): void;
  copyLink(url: string): void;
  copyImage(url: string): void;
  saveImage(url: string): void;
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  reload(): void;
  copy(): void;
  paste(): void;
  /** Absent where annotate mode isn't available (no daemon support, a private tab). */
  annotate?: (() => void) | undefined;
  screenshot(): void;
  viewSource(): void;
  /** Developer tools; a string says why they can't open here. */
  inspect: (() => void) | string;
}

const icon = (glyph: typeof CopyIcon) => <Icon icon={glyph} />;

/**
 * The right-click menu over a page drawn by ace (the screencast): the link or image under the
 * pointer first, as a browser's menu has them. The desktop's own pages get
 * the native menu instead (`apps/desktop/src/main/browser/context-menu.ts`); both offer the same
 * history, editing and page tools, in the same order.
 */
export function PageContextMenu(props: { menu: PageMenu; children: ReactElement }) {
  const { menu } = props;
  const link = menu.target?.link;
  const image = menu.target?.image;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={props.children} />
      <ContextMenuContent>
        {link && (
          <>
            <MenuItem icon={icon(PlusSquareIcon)} onClick={() => menu.openLink(link)}>
              Open link in new tab
            </MenuItem>
            <MenuItem icon={icon(LinkIcon)} onClick={() => menu.copyLink(link)}>
              Copy link
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {image && (
          <>
            <MenuItem icon={icon(ImageIcon)} onClick={() => menu.copyImage(image)}>
              Copy image
            </MenuItem>
            <MenuItem icon={icon(DownloadSimpleIcon)} onClick={() => menu.saveImage(image)}>
              Save image as…
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem icon={icon(ArrowLeftIcon)} disabled={!menu.canBack} onClick={menu.back}>
          Back
        </MenuItem>
        <MenuItem icon={icon(ArrowRightIcon)} disabled={!menu.canForward} onClick={menu.forward}>
          Forward
        </MenuItem>
        <MenuItem icon={icon(ArrowClockwiseIcon)} onClick={menu.reload}>
          Reload
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={icon(CopyIcon)} onClick={menu.copy}>
          Copy
        </MenuItem>
        <MenuItem icon={icon(ClipboardTextIcon)} onClick={menu.paste}>
          Paste
        </MenuItem>
        <MenuSeparator />
        {menu.annotate && (
          <MenuItem icon={icon(CursorClickIcon)} onClick={menu.annotate}>
            Annotate this element
          </MenuItem>
        )}
        <MenuItem icon={icon(CameraIcon)} onClick={menu.screenshot}>
          Take a screenshot
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={icon(FileCodeIcon)} onClick={menu.viewSource}>
          View page source
        </MenuItem>
        <MenuItem
          icon={icon(CodeIcon)}
          disabled={typeof menu.inspect === "string"}
          reason={typeof menu.inspect === "string" ? menu.inspect : undefined}
          onClick={typeof menu.inspect === "function" ? menu.inspect : undefined}
        >
          Inspect
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
