import type { ClientApi } from "@ace/client";
import type { SpadeAgent, SpadeTemplate } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { importAgent, readTemplates } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";

/*
 * Two ways to start a bot besides a blank form (ADR 0132): from one of the templates Spade ships,
 * or from a bot file another machine exported.
 */

/**
 * The templates of the chosen machine's Spade, each its name and one line on what it does.
 * Picking one fills the form; picking it again lets it go.
 */
export function TemplateChoice(props: {
  client: ClientApi | undefined;
  machineKey: string;
  value: string | undefined;
  onChange(template: SpadeTemplate | undefined): void;
}) {
  const client = props.client;
  const templates = useQuery({
    queryKey: ["spade", "templates", props.machineKey],
    queryFn: ({ signal }) =>
      client ? readTemplates(client, { signal }) : Promise.reject(new Error("offline")),
    enabled: client !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (templates.isError)
    return <p className="text-xs text-muted-foreground">Templates couldn't be read.</p>;
  if (!templates.data) return null;
  if (templates.data.length === 0)
    return <p className="text-xs text-muted-foreground">This machine has no templates.</p>;
  return (
    <ul aria-label="Templates" className="flex max-h-44 flex-col overflow-y-auto">
      {templates.data.map((template) => {
        const chosen = props.value === template.id;
        return (
          <li key={template.id}>
            <button
              type="button"
              aria-pressed={chosen}
              onClick={() => props.onChange(chosen ? undefined : template)}
              className={cn(
                "flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
                chosen && "bg-active",
              )}
            >
              <span className="truncate text-ui text-foreground">{template.name}</span>
              {template.blurb && (
                <span className="truncate text-xs text-muted-foreground">{template.blurb}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The person's IANA time zone, for a template's routines; undefined when the browser won't say. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The largest bot file Import reads: 6 MiB, room for a face image and the bot's settings. */
export const botFileMax = 6 * 1024 * 1024;

/**
 * Import bot: picks a `.json` bot file and sends it to the chosen machine's Spade. What that
 * machine left out comes back as lines the dialog shows before opening the new bot, on the
 * machine it was sent to. A file over `botFileMax` isn't read.
 */
export function ImportBot(props: {
  host: SpadeHost | undefined;
  onImported(agent: SpadeAgent, leftOut: readonly string[], host: SpadeHost): void;
  onProblem(problem: string | undefined): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const take = async (file: File | undefined) => {
    // The machine it goes to, as chosen now: the bot opens there even if the choice moves.
    const host = props.host;
    const client = host?.machine.client;
    if (!file || !host || !client) return;
    if (file.size > botFileMax) {
      props.onProblem("That file is too big for a bot file (6 MB at most).");
      if (input.current) input.current.value = "";
      return;
    }
    setImporting(true);
    props.onProblem(undefined);
    try {
      const answer = await importAgent(client, await file.text());
      props.onImported(answer.agent, answer.leftOut, host);
    } catch (error) {
      props.onProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Bot file"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => void take(event.target.files?.[0])}
      />
      <Button
        variant="ghost"
        disabled={importing || !props.host?.machine.client}
        onClick={() => input.current?.click()}
        className="mr-auto"
      >
        {importing ? "Importing…" : "Import bot"}
      </Button>
    </>
  );
}
