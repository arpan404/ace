import {
  spadeCaseMarkWords,
  spadeCaseTriggerWords,
  type SpadeCaseSummary,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { casesKey, deleteCase, useSpadeCases } from "./spade-cases-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * The runs the person kept as tests (ADR 0204 §1), in the bot's profile: each by what it was
 * asked, with its mark, its line of why and what it answered, and Delete. Nothing shows until
 * the person keeps one: Keep as a test is on a reply's More menu.
 */

/** "Marked wrong · It picked a stop-over · From Morning fares", then what it answered. */
function caseLine(each: SpadeCaseSummary): string {
  const head = [spadeCaseMarkWords(each.mark), each.why, spadeCaseTriggerWords(each.trigger)]
    .filter(Boolean)
    .join(" · ");
  const answered = each.outcome && `Answered: ${each.outcome}`;
  return [head, answered].filter(Boolean).join("\n");
}

export function ProfileCases(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const cases = useSpadeCases(bot.id);
  const [deleting, setDeleting] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  if (cases.isError) {
    return (
      <ProfileSection label="Kept as tests">
        <ProfileProblem
          text="Couldn't read the runs kept as tests."
          onRetry={() => void cases.refetch()}
        />
      </ProfileSection>
    );
  }
  if (!cases.data?.length) return null;
  const remove = async (id: string) => {
    setDeleting(id);
    setRefusal(undefined);
    try {
      await deleteCase(client, bot.id, id);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      await cache.invalidateQueries({ queryKey: casesKey(machine, bot.id) });
      setDeleting(undefined);
    }
  };
  return (
    <ProfileSection label="Kept as tests">
      {cases.data.map((each) => (
        <SettingRow
          key={each.id}
          title={each.given || "A run"}
          description={<span className="whitespace-pre-line">{caseLine(each)}</span>}
          density="compact"
          inline
        >
          <Button
            size="sm"
            variant="ghost"
            className={rowPill}
            aria-label={`Delete the test “${each.given || "A run"}”`}
            disabled={deleting === each.id}
            onClick={() => void remove(each.id)}
          >
            Delete
          </Button>
        </SettingRow>
      ))}
      {refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}
