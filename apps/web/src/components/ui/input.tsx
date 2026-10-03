import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

const field =
  "w-full min-w-0 rounded-md bg-secondary px-2.5 text-ui text-foreground outline-none transition-shadow duration-150 placeholder:text-subtle-foreground focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)] focus-visible:outline-none disabled:opacity-50 aria-invalid:shadow-[0_0_0_1px_var(--destructive)]";

function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn(field, "h-8", className)} {...props} />;
}

/** Multi-line field. The composer owns its own auto-growing textarea. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(field, "min-h-20 resize-y py-2 leading-normal", className)}
      {...props}
    />
  );
}

export { Input, Textarea, field as fieldClassName };
