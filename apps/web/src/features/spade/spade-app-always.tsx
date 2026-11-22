import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { addGrant, securityKey } from "./spade-security-api.ts";

/**
 * "Always allow for Notion" on a connected app's ordinary write (ADR 0202, amendment 5): a grant
 * for this bot of the tools on the card, each pinned to the definition the person was shown,
 * which Spade takes only with the person's stamp. ace's daemon stamps
 * it when this window has proved it is them; otherwise the person confirms here, and it is made
 * then. `allow` resolves true once the grant is made; `prompt` is what to show meanwhile (the
 * confirmation, or why it failed).
 */
export function useAppAlways(botId: string) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [waiting, setWaiting] = useState<{
    app: string;
    tools: Record<string, string>;
    next(): void;
  }>();
  const [problem, setProblem] = useState<string>();
  const grant = async (app: string, tools: Record<string, string>) => {
    await addGrant(client, botId, { kind: "app", app, writes: true, tools });
    await cache.invalidateQueries({ queryKey: securityKey });
  };
  const allow = async (
    app: string,
    tools: Record<string, string>,
    next: () => void,
  ): Promise<boolean> => {
    setProblem(undefined);
    try {
      await grant(app, tools);
      next();
      return true;
    } catch (error) {
      const message = fault(error);
      if (isStandingRefusal(message)) setWaiting({ app, tools, next });
      else setProblem(message);
      return false;
    }
  };
  const prompt: ReactNode = waiting ? (
    <ConfirmPerson
      client={client}
      onConfirmed={() => {
        const { app, tools, next } = waiting;
        setWaiting(undefined);
        void allow(app, tools, next);
      }}
    />
  ) : problem ? (
    <p role="alert" className="text-xs text-destructive">
      {`Couldn't allow it always. ${problem}`}
    </p>
  ) : undefined;
  return { allow, prompt, confirming: waiting !== undefined };
}
