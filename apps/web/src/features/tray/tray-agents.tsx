import { hoverStatusLine, threadLiveFact } from "@ace/ui-core";
import { RowProvider, RowStatus, useThreadCard } from "@/features/home/index.ts";
import type { DesktopTray } from "@/boot/desktop-tray.ts";
import { cn } from "@/lib/cn.ts";
import { TrayEmpty, TrayList, TraySection } from "./tray-parts.tsx";
import type { TrayThreads } from "./tray-threads.ts";

/**
 * The Agents tab: what needs the person, then what works, each row as the sidebar draws its
 * status (the same icon, colour and running time). A row opens its thread in the app window.
 */
export function TrayAgents(props: { threads: TrayThreads; live: boolean; tray: DesktopTray }) {
  const { needsYou, working } = props.threads;
  if (!props.live) return <TrayEmpty>Waiting for the daemon…</TrayEmpty>;
  if (needsYou.length + working.length === 0) return <TrayEmpty>No agent is working.</TrayEmpty>;
  return (
    <TrayList>
      {needsYou.length > 0 && (
        <li>
          <TraySection label="Needs you">
            {needsYou.map((id) => (
              <TrayThread key={id} threadId={id} tray={props.tray} />
            ))}
          </TraySection>
        </li>
      )}
      {working.length > 0 && (
        <li>
          <TraySection label="Working">
            {working.map((id) => (
              <TrayThread key={id} threadId={id} tray={props.tray} />
            ))}
          </TraySection>
        </li>
      )}
    </TrayList>
  );
}

function TrayThread(props: { threadId: string; tray: DesktopTray }) {
  const data = useThreadCard(props.threadId, false);
  if (!data) return null;
  const { card, entry } = data;
  const line = hoverStatusLine({ attention: card.attention, card, fact: threadLiveFact(entry) });
  const detail = line.detail ?? (line.sentence ? { text: line.sentence, code: false } : undefined);
  return (
    <button
      type="button"
      onClick={() => props.tray.open({ kind: "thread", threadId: props.threadId })}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <RowProvider card={card} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-ui text-foreground">{card.title}</span>
        {detail && (
          <span
            className={cn(
              "mt-0.5 block truncate text-meta text-muted-foreground",
              detail.code && "font-mono",
            )}
          >
            {detail.text}
          </span>
        )}
      </span>
      <RowStatus card={card} attention={card.attention} />
    </button>
  );
}
