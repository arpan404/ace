import { CaretDownIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Icon } from "@/components/icon.tsx";

/** One of a filter's choices; `""` is "any". */
export interface Choice {
  value: string;
  label: string;
}

/** A filter of the Filters menu: one choice of several, or any number of labels. */
export type FilterSection =
  | {
      kind: "one";
      id: string;
      label: string;
      value: string;
      choices: Choice[];
      onChange(value: string): void;
    }
  | {
      kind: "many";
      id: string;
      label: string;
      values: string[];
      choices: Choice[];
      onChange(values: string[]): void;
    };

const triggerClass =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui text-muted-foreground focus-ring transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground aria-expanded:bg-hover";

/** The quiet "Filters ⌄" menu: each filter a submenu, with how many are on and a way to clear them. */
export function FiltersMenu(props: { sections: FilterSection[]; onClear(): void }) {
  const active = props.sections.filter((section) =>
    section.kind === "one" ? section.value !== "" : section.values.length > 0,
  ).length;
  return (
    <Menu>
      <MenuTrigger aria-label={`Filters${active ? `: ${active} on` : ""}`} className={triggerClass}>
        <FunnelSimpleIcon aria-hidden size={14} />
        Filters
        {active > 0 && <span className="text-foreground tabular-nums">{active}</span>}
        <CaretDownIcon aria-hidden size={13} />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-52">
        {props.sections.map((section) => (
          <MenuSub key={section.id}>
            <MenuSubTrigger>{section.label}</MenuSubTrigger>
            <MenuContent
              aria-label={section.label}
              side="right"
              align="start"
              className="max-h-80 min-w-44 overflow-y-auto"
            >
              {section.kind === "one" ? (
                <MenuRadioGroup
                  value={section.value}
                  onValueChange={(value: unknown) => {
                    const picked = section.choices.find((choice) => choice.value === value);
                    if (picked) section.onChange(picked.value);
                  }}
                >
                  {section.choices.map((choice) => (
                    <MenuRadioItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              ) : section.choices.length ? (
                section.choices.map((choice) => (
                  <MenuCheckboxItem
                    key={choice.value}
                    checked={section.values.includes(choice.value)}
                    onCheckedChange={(checked: boolean) =>
                      section.onChange(
                        checked
                          ? [...section.values, choice.value]
                          : section.values.filter((value) => value !== choice.value),
                      )
                    }
                  >
                    {choice.label}
                  </MenuCheckboxItem>
                ))
              ) : (
                <MenuItem disabled>None in this list</MenuItem>
              )}
            </MenuContent>
          </MenuSub>
        ))}
        {active > 0 && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Icon icon={FunnelSimpleIcon} />} onClick={props.onClear}>
              Clear filters
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
