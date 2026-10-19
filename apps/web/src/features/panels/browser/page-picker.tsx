import { CheckIcon } from "@phosphor-icons/react";
import { useState, type RefObject } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { menuItem, menuLabel } from "@/components/ui/menu-styles.ts";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { Sheet, SheetContent } from "@/components/ui/sheet.tsx";
import { cn } from "@/lib/cn.ts";
import type { BrowserPageView } from "../sources.ts";

type Picker = NonNullable<BrowserPageView["picker"]>;

const names: Record<Picker["kind"], string> = {
  select: "Choose an option",
  date: "Choose a date",
  time: "Choose a time",
  "datetime-local": "Choose a date and time",
  month: "Choose a month",
  week: "Choose a week",
  color: "Choose a colour",
};

/**
 * ace's own picker for one the page opened: the select's options, or a date, time or colour
 * field. Anchored under the page's element on a wide screen; a bottom sheet on a phone.
 * Choosing sends the value; closing it any other way leaves the page's value as it was.
 */
export function PagePicker(props: {
  picker: Picker;
  /** The element's box on screen, read when the popover places itself. */
  anchor(): DOMRect | undefined;
  sheet: boolean;
  /** Where focus goes back to once the picker closes: the page. */
  returnFocus: RefObject<HTMLElement | null>;
  onPick(values: readonly string[] | undefined): void;
}) {
  const { picker } = props;
  const close = (open: boolean) => {
    if (!open) props.onPick(undefined);
  };
  const body = <PickerBody picker={picker} sheet={props.sheet} onPick={props.onPick} />;
  if (props.sheet)
    return (
      <Sheet open onOpenChange={close}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          finalFocus={props.returnFocus}
          aria-label={names[picker.kind]}
          className="max-h-[70vh] gap-0 overflow-y-auto p-2 pb-[max(env(safe-area-inset-bottom),8px)]"
        >
          {body}
        </SheetContent>
      </Sheet>
    );
  return (
    <Popover open onOpenChange={close}>
      <PopoverContent
        anchor={{ getBoundingClientRect: () => props.anchor() ?? new DOMRect() }}
        finalFocus={props.returnFocus}
        aria-label={names[picker.kind]}
        sideOffset={4}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

function PickerBody(props: {
  picker: Picker;
  sheet: boolean;
  onPick(values: readonly string[] | undefined): void;
}) {
  const { picker } = props;
  if (picker.kind === "select")
    return <OptionList picker={picker} sheet={props.sheet} onPick={props.onPick} />;
  return <ValueField picker={picker} onPick={props.onPick} />;
}

function OptionList(props: {
  picker: Picker;
  sheet: boolean;
  onPick(values: readonly string[]): void;
}) {
  const options = props.picker.options ?? [];
  return (
    <div className={cn("flex flex-col overflow-y-auto", !props.sheet && "max-h-72 min-w-48")}>
      {options.map((option, index) => {
        const chosen = option.value === props.picker.value;
        const group = option.group !== options[index - 1]?.group ? option.group : undefined;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- one picker's options never reorder, and values may repeat
          <div key={`${index}:${option.value}`} className="contents">
            {group && <div className={menuLabel}>{group}</div>}
            <button
              type="button"
              disabled={option.disabled}
              aria-pressed={chosen}
              className={cn(
                menuItem,
                "hover:bg-accent disabled:opacity-50 pointer-coarse:h-10",
                option.group && "pl-4",
              )}
              onClick={() => props.onPick([option.value])}
            >
              <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
              {chosen && <CheckIcon aria-hidden size={14} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ValueField(props: { picker: Picker; onPick(values: readonly string[]): void }) {
  const { picker } = props;
  const [value, setValue] = useState(picker.value);
  return (
    <form
      className="flex items-center gap-2 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        props.onPick([value]);
      }}
    >
      <Input
        type={picker.kind}
        aria-label={names[picker.kind]}
        value={value}
        min={picker.min}
        max={picker.max}
        step={picker.step}
        autoFocus
        className={picker.kind === "color" ? "w-16 p-0.5" : "min-w-40"}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="sm">
        Set
      </Button>
    </form>
  );
}
