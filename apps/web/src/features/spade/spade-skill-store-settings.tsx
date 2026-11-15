import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { addSkillToAce, readSkillStore, type SpadeStoredSkill } from "./spade-skills-api.ts";

const storeKey = ["spade", "skill-store"] as const;

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Settings › Spade › Skills (ADR 0151): the skills Spade wrote while ace was away, each with
 * Add to ace's library. Spade never sends one there on its own. Shows nothing when there are
 * none.
 */
export function SkillStoreSettings(props: { ready: boolean }) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const store = useQuery({
    queryKey: [...storeKey, machine],
    queryFn: ({ signal }) => readSkillStore(client, { signal }),
    enabled: props.ready,
  });
  const own = store.data?.skills.filter((skill) => skill.origin === "spade") ?? [];
  if (!store.data || own.length === 0) return null;
  const ace = store.data.ace;
  return (
    <SettingSection label="Skills" anchor="skills">
      {!ace && (
        <SettingRow
          title="Written in Spade"
          description="Spade's bots saved these while ace was away. Add them to ace's library once ace is running."
        />
      )}
      {own.map((skill) => (
        <SkillRow key={skill.id} skill={skill} ace={ace} />
      ))}
    </SettingSection>
  );
}

function SkillRow(props: { skill: SpadeStoredSkill; ace: boolean }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    try {
      await addSkillToAce(client, props.skill.id);
      toast.success({ title: `Added ${props.skill.name} to ace's library` });
    } catch (error) {
      toast.error({ title: "Couldn't add the skill", description: fault(error) });
    } finally {
      setAdding(false);
      await cache.invalidateQueries({ queryKey: storeKey });
    }
  };
  return (
    <SettingRow title={props.skill.name} description={props.skill.description}>
      {props.ace && (
        <Button size="sm" disabled={adding} onClick={() => void add()}>
          Add to ace's library
        </Button>
      )}
    </SettingRow>
  );
}
