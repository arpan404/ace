import { ArrowSquareOutIcon, PushPinSlashIcon, PuzzlePieceIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { LocalStore } from "../store.ts";
import type { BrowserExtensionView, BrowserView, PreviewSource } from "../sources.ts";
import { toolbarButton } from "./page-toolbar.tsx";

const hiddenKey = "ace.browser.extensionsHidden";
function readHidden(): boolean {
  try {
    return globalThis.localStorage?.getItem(hiddenKey) === "1";
  } catch {
    return false;
  }
}

/** "Hide from toolbar": the Extensions button stays out of the toolbar until shown again. */
export const extensionsHidden = new LocalStore<boolean>(readHidden());
extensionsHidden.subscribe(() => {
  try {
    if (extensionsHidden.get()) globalThis.localStorage?.setItem(hiddenKey, "1");
    else globalThis.localStorage?.removeItem(hiddenKey);
  } catch {
    // Storage blocked: the choice lasts for this window.
  }
});

type Listing = { state: "loading" } | { state: "ready"; items: readonly BrowserExtensionView[] };

/**
 * Extensions, in the toolbar's right pill: what the shown tab's browser engine runs, as its
 * backend reports it, never a made-up list. The in-app browser and ace's Chrome load no store
 * extensions of their own, so the menu points to Use my Chrome, where agents work in the
 * person's own Chrome with its extensions. In a tab of the person's Chrome, its extensions are
 * already there.
 */
export function ExtensionsMenu(props: {
  source: PreviewSource;
  threadId: string;
  backend: BrowserView["backend"];
  online: boolean;
}) {
  const navigate = useNavigate();
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const read = () => {
    setListing({ state: "loading" });
    const list = props.source.extensions?.(props.threadId);
    if (!list) return setListing({ state: "ready", items: [] });
    void list.then(
      (items) => setListing({ state: "ready", items }),
      () => setListing({ state: "ready", items: [] }),
    );
  };
  const items = listing.state === "ready" ? listing.items : [];
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) read();
      }}
    >
      <MenuTrigger
        render={
          <IconButton
            icon={PuzzlePieceIcon}
            label="Extensions"
            disabled={!props.online}
            className={toolbarButton}
          />
        }
      />
      <MenuContent align="end" className="w-64">
        <MenuGroup>
          <MenuLabel>
            {listing.state === "loading" ? "Extensions" : `Extensions (${items.length})`}
          </MenuLabel>
          {listing.state === "ready" && items.length === 0 && (
            <MenuItem disabled>No extensions installed</MenuItem>
          )}
          {items.map((extension) => (
            <MenuItem key={extension.id} disabled icon={<Icon icon={PuzzlePieceIcon} />}>
              {extension.name}
              {!extension.enabled && " · Off"}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        {props.backend !== "user" && (
          <MenuItem
            icon={<Icon icon={ArrowSquareOutIcon} />}
            onClick={() => void navigate({ to: "/settings/computer-use" })}
          >
            Use your Chrome's extensions
          </MenuItem>
        )}
        <MenuItem
          icon={<Icon icon={PushPinSlashIcon} />}
          onClick={() => extensionsHidden.set(() => true)}
        >
          Hide from toolbar
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
