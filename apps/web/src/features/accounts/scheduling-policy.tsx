import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { SettingsValues } from "@ace/protocol";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";

type LimitPolicy = SettingsValues["threads.limitPolicy"];

const choices: readonly { value: LimitPolicy; title: string; description: string }[] = [
  {
    value: "manual",
    title: "Stop and let me decide",
    description: "The thread shows Limited with the reset time. Resume, wait or move it yourself.",
  },
  {
    value: "resume_at_reset",
    title: "Resume when the window resets",
    description: "Queued work continues on the same account as soon as the provider allows it.",
  },
  {
    value: "snooze_until_reset",
    title: "Snooze the thread until the window resets",
    description: "It leaves Home until the reset, then comes back for you to continue.",
  },
  {
    value: "migrate_now",
    title: "Move it to another account right away",
    description:
      "Same provider, the account with the most headroom. The conversation goes with it.",
  },
];

/** "When an account runs out": the daemon's `threads.limitPolicy`, applied to limited threads. */
export function SchedulingPolicySection() {
  const [stored, setPolicy] = useDaemonSetting("threads.limitPolicy");
  const policy = stored ?? "manual";
  const toast = useToast();
  return (
    <section aria-labelledby="policy-title" className="mt-10">
      <h2 id="policy-title" className="text-md font-medium">
        When an account runs out
      </h2>
      <p className="mt-1 text-ui text-muted-foreground">
        Applies when a thread hits its account's limit. Running turns always finish on the account
        they started with.
      </p>
      <RadioGroup
        aria-labelledby="policy-title"
        value={policy}
        onValueChange={(value) => {
          const picked = choices.find((choice) => choice.value === value);
          if (picked)
            void setPolicy(picked.value).catch((error: unknown) =>
              toast.error({
                title: error instanceof Error ? error.message : "Couldn't save that policy.",
              }),
            );
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
    </section>
  );
}
