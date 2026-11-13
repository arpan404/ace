import { spadeHostOf, type SpadeAvatar, type SpadeSurface } from "@ace/ui-core/spade-chat";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { SurfaceLive } from "./surface-live.tsx";

/**
 * A bot's browser (under its address) or screen in the expanded computer: the live view, which
 * takes the person's input while they may act (cowork, or exclusive while they drive).
 */
export function SurfacePicture(props: {
  machine: { key: string; name: string; primary: boolean };
  bot: { id: string; name: string; avatar: SpadeAvatar };
  kind: "browser" | "screen";
  surface: SpadeSurface | undefined;
  threadId: string | undefined;
  mayAct: boolean;
  driving: boolean;
  label: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-0 p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-code shadow-[inset_0_0_0_1px_var(--border)]">
        {props.kind === "browser" && <AddressBar url={props.surface?.url} />}
        {/* A full-height column, so the live view fills it and the picture centres in it. */}
        <div className="relative flex min-h-0 flex-1 flex-col bg-background *:min-h-0 *:flex-1">
          <SurfaceLive {...props} />
        </div>
      </div>
    </div>
  );
}

/** The page's address: its host, then the rest muted. Read-only: the bot or the person browses. */
function AddressBar(props: { url: string | undefined }) {
  const host = spadeHostOf(props.url);
  let rest = "";
  try {
    if (props.url) {
      const url = new URL(props.url);
      rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    }
  } catch {
    rest = "";
  }
  const secure = props.url?.startsWith("https:");
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      {secure && (
        <Icon icon={LockSimpleIcon} size={14} className="shrink-0 text-muted-foreground" />
      )}
      <p
        aria-label="Address"
        className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate rounded-md bg-secondary px-2.5 py-1 text-ui"
      >
        <span className="text-foreground">{host ?? props.url ?? "No page open"}</span>
        <span className="truncate text-muted-foreground">{rest}</span>
      </p>
    </div>
  );
}
