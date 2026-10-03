import { CaretDownIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuLabel,
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { AutoSettle } from "@ace/ui-core";

const choices: Record<AutoSettle, string> = {
  "1d": "after a day",
  "2d": "after 2 days",
  "1w": "after a week",
  never: "never",
};
const options: Record<AutoSettle, string> = {
  "1d": "After a day",
  "2d": "After 2 days",
  "1w": "After a week",
  never: "Never",
};

/**
 * The daemon's auto-settle rule (`threads.autoSettleAfter`), said in a sentence under Settled,
 * with the window one click away.
 */
export function AutoSettleNote() {
  const [setting, setAutoSettle] = useDaemonSetting("threads.autoSettleAfter");
  const toast = useToast();
  const autoSettle = setting ?? "1d";
  return (
    <p className="px-[11px] pt-2 pb-1 text-xs leading-normal text-subtle-foreground">
      {autoSettle === "never" ? "Done threads stay until you settle them" : "Done threads settle"}{" "}
      <Menu>
        <MenuTrigger
          disabled={setting === undefined}
          aria-label="When done threads settle"
          className="inline-flex items-center gap-0.5 rounded-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        >
          {autoSettle === "never" ? "(change)" : choices[autoSettle]}
          <CaretDownIcon aria-hidden size={10} />
        </MenuTrigger>
        <MenuContent className="min-w-[200px]">
          <MenuGroup>
            <MenuLabel>Settle done threads</MenuLabel>
            <MenuRadioGroup
              value={autoSettle}
              onValueChange={(value) => {
                const parsed = AutoSettle.safeParse(value);
                if (parsed.success)
                  setAutoSettle(parsed.data).catch(() =>
                    toast.add({ title: "Couldn't change when threads settle" }),
                  );
              }}
            >
              {AutoSettle.options.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {options[option]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuContent>
      </Menu>
      {autoSettle === "never" ? "." : " without activity."} Threads that need you never settle.
    </p>
  );
}
