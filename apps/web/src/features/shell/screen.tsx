import { useState } from "react";
import type { ReactNode, UIEvent } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { AppHeader, type HeaderProps } from "./app-header.tsx";
import { ConnectionNotice } from "./connection-notice.tsx";
import { ShellPanel, type PanelDefinition } from "./panels.tsx";

/**
 * The main column of every route: the shared header, the content and, where a screen has
 * them, the right and bottom panels. Slices fill `children` and the panel tabs; the frame,
 * keyboard map and persistence are the shell's.
 */
export function Screen(
  props: HeaderProps & {
    right?: PanelDefinition;
    bottom?: PanelDefinition;
    children: ReactNode;
  },
) {
  const [scrolled, setScrolled] = useState(false);
  const { togglePanel } = useLayout();
  useHotkey(keymap.bottomPanel.keys, () => togglePanel("bottom"), { enabled: !!props.bottom });
  // Any scroller inside the content draws the header hairline once it leaves the top.
  const onScroll = (event: UIEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement) setScrolled(target.scrollTop > 0);
  };
  return (
    <>
      <AppHeader
        title={props.title}
        subtitle={props.subtitle}
        menu={props.menu}
        actions={props.actions}
        scrolled={scrolled}
        panels={{ right: !!props.right, bottom: !!props.bottom }}
      />
      <ConnectionNotice />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <main
            id="main"
            tabIndex={-1}
            onScrollCapture={onScroll}
            className="relative min-h-0 flex-1 outline-none"
          >
            {props.children}
          </main>
          {props.bottom && <ShellPanel side="bottom" panel={props.bottom} />}
        </div>
        {props.right && <ShellPanel side="right" panel={props.right} />}
      </div>
    </>
  );
}

/** Scrollable page body: centred column, 44px top and 32px side padding. */
export function Page(props: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-auto">
      <div
        className={
          props.wide
            ? "mx-auto max-w-[1040px] px-8 pt-11 pb-20"
            : "mx-auto max-w-(--column) px-8 pt-11 pb-20"
        }
      >
        {props.children}
      </div>
    </div>
  );
}

/** Page title (22/600) with an optional lede, for pages without a list-detail layout. */
export function PageTitle(props: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-semibold tracking-title">{props.title}</h2>
        {props.lede && (
          <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
            {props.lede}
          </p>
        )}
      </div>
      {props.actions}
    </div>
  );
}
