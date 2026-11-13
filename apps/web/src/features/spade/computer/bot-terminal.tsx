import { lazy, Suspense, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { loadStandaloneTerminal } from "@/features/panels/index.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import { spadeTransport } from "../spade-transport.ts";
import { resizeTerminal, typeInTerminal } from "./computer-api.ts";
import { spadeTerminalSource } from "./terminal-source.ts";

const StandaloneTerminal = lazy(loadStandaloneTerminal);

const later = (delay: number, run: () => void) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

/**
 * The bot's terminal, attached to its PTY in ace's terminal view. Everyone sees the same shell,
 * the person's own: the bot's commands run apart from it and show in it. Keys go to it whenever
 * the person may act, in cowork with no take-over, and in exclusive mode while they drive.
 */
export function BotTerminal(props: { bot: { id: string; name: string }; mayType: boolean }) {
  const client = useSpadeClient();
  const toast = useToast();
  const [source] = useState(() =>
    spadeTerminalSource({
      transport: spadeTransport(client),
      bot: props.bot.id,
      name: `${props.bot.name}'s terminal`,
      type: (data) => typeInTerminal(client, props.bot.id, data),
      resize: (cols, rows) => resizeTerminal(client, props.bot.id, cols, rows),
      failed: (error) =>
        toast.error({ title: "That didn't reach the terminal", description: message(error) }),
      later,
    }),
  );
  useEffect(() => source.setTyping(props.mayType), [source, props.mayType]);
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-code p-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center">
              <Spinner label="Opening the terminal" />
            </div>
          }
        >
          <StandaloneTerminal
            source={source}
            id={`spade:${props.bot.id}`}
            label={`${props.bot.name}'s`}
            readOnly={!props.mayType}
            autoFocus={props.mayType}
          />
        </Suspense>
      </div>
    </div>
  );
}
