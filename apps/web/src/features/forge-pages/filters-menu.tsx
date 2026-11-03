import { CaretDownIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";

/** One of a filter's choices; `""` is "any". */
export interface Choice {
  value: string;
  label: string;
}

/**
 * One of the box header's filter menus: one choice of several, or any number of labels. A view
 * setting (sort) sits among them, but never counts as a filter that is on.
 */
export type FilterSection =
  | {
      kind: "one";
      id: string;
      label: string;
      value: string;
      choices: Choice[];
      onChange(value: string): void;
      setting?: boolean;
    }
  | {
      kind: "many";
      id: string;
      label: string;
      values: string[];
      choices: Choice[];
      onChange(values: string[]): void;
    };

/** A section is narrowing the list. */
export const isOn = (section: FilterSection) =>
  section.kind === "one" ? !section.setting && section.value !== "" : section.values.length > 0;

function FilterMenu(props: { section: FilterSection }) {
  const { section } = props;
  const on = isOn(section);
  const chosen =
    section.kind === "one"
      ? section.choices.find((choice) => choice.value === section.value)?.label
      : String(section.values.length);
  return (
    <Menu>
      <MenuTrigger
        aria-label={on ? `${section.label}: ${chosen}` : section.label}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-ui focus-ring transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground aria-expanded:bg-hover",
          on ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {section.label}
        {on && section.kind === "many" && (
          <span className="rounded-full bg-fill px-1.5 text-xs leading-[18px] tabular-nums">
            {chosen}
          </span>
        )}
        <CaretDownIcon aria-hidden size={12} />
      </MenuTrigger>
      <MenuContent
        aria-label={section.label}
        align="end"
        className="max-h-80 min-w-48 overflow-y-auto"
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
    </Menu>
  );
}

/** The box header's filter menus, GitHub's "Author ▾ Label ▾ … Sort ▾", right-aligned. */
export function FilterMenus(props: { sections: FilterSection[] }) {
  return (
    <div
      role="group"
      aria-label="Filters"
      className="ml-auto flex min-w-0 flex-wrap items-center justify-end"
    >
      {props.sections.map((section) => (
        <FilterMenu key={section.id} section={section} />
      ))}
    </div>
  );
}
