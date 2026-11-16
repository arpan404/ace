import { spadeServiceWords, type SpadeService } from "@ace/ui-core/spade-chat";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SettingCard } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeClient } from "../spade-machine.tsx";
import { ProfileProblem, rowPill } from "../spade-profile-parts.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { readServiceLines, stopService } from "./services-api.ts";

/** Lines read when a log opens, and how often an open log of a running service reads more. */
const firstLines = 200;
const followMs = 2_000;
/** Lines an open log keeps; older ones fall off the top. */
const keptLines = 2_000;

/** Every services read; a bot's under `[...servicesKey, machine, bot]`. */
export const servicesKey = ["spade", "services"] as const;

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Computer › Services: the processes the bot keeps running, a tool and never work, so nothing
 * here makes it read as busy. Each row: its name and command, and how it is (Running, Ended ·
 * exit 255, Lost when Spade restarted). The row opens its output in place under it; hovering it
 * or opening it gives Logs and, while it runs, Stop.
 */
export function BotServices(props: { bot: RosterBot; services: UseQueryResult<SpadeService[]> }) {
  const { services } = props;
  const [open, setOpen] = useState<string>();
  if (services.isPending) return <ListSkeleton label="services" shape="row" rows={2} />;
  if (!services.data)
    return (
      <SettingCard>
        <ProfileProblem
          text="Couldn't read the services."
          onRetry={() => void services.refetch()}
        />
      </SettingCard>
    );
  return (
    <SettingCard>
      <ul
        aria-label={`${props.bot.name}'s services`}
        className="flex flex-col divide-y divide-border-soft"
        data-setting-slot=""
      >
        {services.data.map((service) => (
          <ServiceRow
            key={service.id}
            bot={props.bot}
            service={service}
            open={open === service.id}
            onToggle={() => setOpen(open === service.id ? undefined : service.id)}
          />
        ))}
      </ul>
    </SettingCard>
  );
}

function ServiceRow(props: {
  bot: RosterBot;
  service: SpadeService;
  open: boolean;
  onToggle(): void;
}) {
  const { service, bot } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const running = service.state === "running";
  const failed = service.state === "failed" || (service.exitCode ?? 0) !== 0;
  const logId = `service-log-${service.id}`;
  const stop = async () => {
    setStopping(true);
    try {
      await stopService(client, bot.id, service.id);
    } catch (error) {
      toast.error({ title: `Couldn't stop ${service.name}`, description: fault(error) });
    }
    await cache.invalidateQueries({ queryKey: servicesKey });
    setStopping(false);
  };
  return (
    <li className="group/service flex flex-col">
      <div className="grid min-h-(--setting-row-height) grid-cols-[1fr_auto] items-center gap-x-3 py-2">
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={logId}
          aria-label={`${service.name}: ${spadeServiceWords(service)}. Logs`}
          onClick={props.onToggle}
          className="-mx-2 flex min-w-0 flex-col rounded-md px-2 py-0.5 text-left focus-ring"
        >
          <span className="truncate text-ui font-medium text-foreground">{service.name}</span>
          <span className="truncate font-mono text-xs leading-4 text-subtle-foreground">
            {service.command}
          </span>
        </button>
        <span
          className={cn(
            "text-xs whitespace-nowrap tabular-nums",
            failed
              ? "text-(--status-failed-text)"
              : service.state === "lost"
                ? "text-subtle-foreground"
                : "text-muted-foreground",
            running &&
              "pointer-fine:group-hover/service:hidden pointer-fine:group-focus-within/service:hidden",
            running && props.open && "hidden",
          )}
        >
          {spadeServiceWords(service)}
        </span>
        {running && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            className={cn(
              rowPill,
              "-mr-3 hidden pointer-fine:group-hover/service:inline-flex pointer-fine:group-focus-within/service:inline-flex",
              props.open && "inline-flex",
            )}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </div>
      {props.open && <ServiceLog id={logId} bot={bot} service={service} />}
    </li>
  );
}

/**
 * A service's output, in place under its row: the last lines kept, then, while it runs, what it
 * prints next, read every two seconds. It stays at the end unless the person scrolls up.
 */
function ServiceLog(props: { id: string; bot: RosterBot; service: SpadeService }) {
  const { bot, service } = props;
  const client = useSpadeClient();
  const [lines, setLines] = useState<{ n: number; text: string }[]>();
  const [problem, setProblem] = useState<string>();
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const running = service.state === "running";
  useEffect(() => {
    const abort = new AbortController();
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (first: boolean) => {
      try {
        const got = await readServiceLines(
          client,
          bot.id,
          service.id,
          { after, lines: firstLines },
          abort.signal,
        );
        after = got.lines.at(-1)?.n ?? after;
        setProblem(undefined);
        setLines((had) => {
          const all = first ? got.lines : [...(had ?? []), ...got.lines];
          return all.length > keptLines ? all.slice(-keptLines) : all;
        });
        // At the end, it stays there as lines come in.
        requestAnimationFrame(() => {
          const el = box.current;
          if (el && atEnd.current) el.scrollTop = el.scrollHeight;
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setProblem(fault(error));
      }
      if (running && !abort.signal.aborted) timer = setTimeout(() => void read(false), followMs);
    };
    void read(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, bot.id, service.id, running]);
  return (
    <div id={props.id} className="pb-3">
      {problem && !lines ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {problem}
        </p>
      ) : (
        <pre
          ref={box}
          aria-label={`${service.name}'s output`}
          onScroll={(event) => {
            const el = event.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
          className="no-scrollbar max-h-56 min-h-10 overflow-auto rounded-xl bg-chat-well px-3.5 py-3 font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground shadow-[inset_0_0_0_1px_var(--border-soft)] focus-ring"
        >
          {lines === undefined ? (
            " "
          ) : lines.length === 0 ? (
            <span className="text-subtle-foreground">No output yet</span>
          ) : (
            lines.map((line) => line.text).join("\n")
          )}
        </pre>
      )}
    </div>
  );
}
