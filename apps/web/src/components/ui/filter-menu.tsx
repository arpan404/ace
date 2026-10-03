import { CaretDownIcon } from "@phosphor-icons/react";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./menu.tsx";

/**
 * The quiet "All projects ⌄" filter in a second-sidebar header: the current choice as text,
 * a radio menu of the options.
 */
export function FilterMenu<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onValueChange(value: T): void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${props.label}: ${current?.label ?? ""}`}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui text-muted-foreground outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-sidebar-accent"
      >
        {current?.label}
        <CaretDownIcon aria-hidden size={13} />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuRadioGroup
          value={props.value}
          onValueChange={(value: unknown) => {
            const picked = props.options.find((option) => option.value === value);
            if (picked) props.onValueChange(picked.value);
          }}
        >
          {props.options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
