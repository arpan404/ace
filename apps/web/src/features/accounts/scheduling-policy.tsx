import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { usePolicy, useSetPolicy, type SchedulingPolicy } from "./accounts-source.ts";

const choices: readonly {
  value: SchedulingPolicy["onExhausted"];
  title: string;
  description: string;
}[] = [
  {
    value: "switch",
    title: "Switch to the account with the most headroom",
    description: "Same provider, same plan tier or higher. The thread keeps its context.",
  },
  {
    value: "pause",
    title: "Pause the thread until the window resets",
    description: "Nothing moves; you get an Activity item with the reset time.",
  },
  {
    value: "ask",
    title: "Ask me each time",
    description: "An approval card appears in Activity before any switch.",
  },
];

/** "When an account runs out": applies to new turns only. */
export function SchedulingPolicySection() {
  const policy = usePolicy();
  const update = useSetPolicy();
  if (!policy.data) return null;
  return (
    <section aria-labelledby="policy-title" className="mt-10">
      <h2 id="policy-title" className="text-md font-medium">
        When an account runs out
      </h2>
      <p className="mt-1 text-ui text-muted-foreground">
        Applies to new turns. Running turns always finish on the account they started with.
      </p>
      <RadioGroup
        aria-labelledby="policy-title"
        value={policy.data.onExhausted}
        onValueChange={(value) => {
          const picked = choices.find((choice) => choice.value === value);
          if (picked) update.mutate({ onExhausted: picked.value });
        }}
        className="mt-3.5 gap-0"
      >
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-center gap-4 border-t py-3 last:border-b"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">{choice.title}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {choice.description}
              </span>
            </span>
            <RadioGroupItem value={choice.value} />
          </label>
        ))}
      </RadioGroup>
      <div className="mt-[22px]">
        <SettingRow
          title="Keep 10% headroom for interactive threads"
          description="Background and deck lanes stop early so a thread you are typing in never hits the wall."
        >
          <Switch
            aria-label="Keep headroom"
            checked={policy.data.keepHeadroom}
            onCheckedChange={(keepHeadroom) => update.mutate({ keepHeadroom })}
          />
        </SettingRow>
      </div>
    </section>
  );
}
