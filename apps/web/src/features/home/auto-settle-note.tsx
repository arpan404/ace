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
import { AutoSettle } from "./organizer.ts";
import { useOrganizer, useOrganizerState } from "./use-organizer.ts";

const choices: Record<AutoSettle, string> = {
  "1d": "after a day",
  "3d": "after 3 days",
  "1w": "after a week",
  never: "never",
};
const options: Record<AutoSettle, string> = {
  "1d": "After a day",
  "3d": "After 3 days",
  "1w": "After a week",
  never: "Never",
};

/** The auto-settle rule, said in a sentence under Settled, with the window one click away. */
export function AutoSettleNote() {
  const organizer = useOrganizer();
  const { autoSettle } = useOrganizerState();
  return (
    <p className="px-[11px] pt-2 pb-1 text-xs leading-normal text-subtle-foreground">
      {autoSettle === "never" ? "Done threads stay until you settle them" : "Done threads settle"}{" "}
      <Menu>
        <MenuTrigger
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
                if (parsed.success) organizer.setAutoSettle(parsed.data);
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
