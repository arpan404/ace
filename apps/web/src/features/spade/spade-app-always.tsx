import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { addGrant, securityKey } from "./spade-security-api.ts";

/**
 * "Always allow for Notion" on a connected app's write (ADR 0202, amendment 2): a grant of that
 * app's writes for this bot, which Spade takes only with the person's stamp. ace's daemon stamps
 * it when this window has proved it is them; otherwise the person confirms here, and it is made
 * then. `allow` resolves true once the grant is made; `prompt` is what to show meanwhile (the
 * confirmation, or why it failed).
 */
export function useAppAlways(botId: string) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [waiting, setWaiting] = useState<{ app: string; then(): void }>();
  const [problem, setProblem] = useState<string>();
  const grant = async (app: string) => {
    await addGrant(client, botId, { kind: "app", app, writes: true });
    await cache.invalidateQueries({ queryKey: securityKey });
  };
  const allow = async (app: string, then: () => void): Promise<boolean> => {
    setProblem(undefined);
    try {
      await grant(app);
      then();
      return true;
    } catch (error) {
      const message = fault(error);
      if (isStandingRefusal(message)) setWaiting({ app, then });
      else setProblem(message);
      return false;
    }
  };
  const prompt: ReactNode = waiting ? (
    <ConfirmPerson
      client={client}
      onConfirmed={() => {
        const { app, then } = waiting;
        setWaiting(undefined);
        void allow(app, then);
      }}
    />
  ) : problem ? (
    <p role="alert" className="text-xs text-destructive">
      {`Couldn't allow it always. ${problem}`}
    </p>
  ) : undefined;
  return { allow, prompt, confirming: waiting !== undefined };
}
