import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * A search box: glass, a magnifier, the input and a Clear button once there's text. Esc clears
 * the text, then leaves the field. It sits in a sidebar, a pane or a page header.
 */
export function SearchField({
  label,
  value,
  onValueChange,
  trailing,
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange" | "size" | "type"> & {
  label: string;
  value: string;
  onValueChange(value: string): void;
  /** Beside Clear: a spinner while results update. */
  trailing?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <label
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md bg-secondary pr-1 pl-2.5 text-ui text-subtle-foreground has-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus,var(--ring))]",
        className,
      )}
    >
      <Icon icon={MagnifyingGlassIcon} />
      <input
        ref={input}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== "Escape") return;
          event.preventDefault();
          // Empty: leave the field for the page around it.
          if (value) onValueChange("");
          else document.getElementById("main")?.focus();
        }}
        className="min-w-0 flex-1 bg-transparent text-foreground placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        {...props}
      />
      {trailing}
      {value && (
        <IconButton
          icon={XIcon}
          label="Clear"
          size="sm"
          tooltip={false}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        />
      )}
    </label>
  );
}
