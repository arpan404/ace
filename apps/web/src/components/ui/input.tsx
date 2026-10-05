import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn.ts";

const field =
  "w-full min-w-0 rounded-md bg-secondary px-2.5 text-ui text-foreground outline-none transition-shadow duration-(--dur-1) placeholder:text-subtle-foreground focus-visible:shadow-[0_0_0_2px_var(--tint-line)] focus-visible:outline-none disabled:opacity-50 aria-invalid:shadow-[0_0_0_1px_var(--destructive)]";

function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn(field, "h-8", className)} {...props} />;
}

/**
 * Multi-line field that grows with its text up to 40% of the window, with no resize grip.
 * The composer owns its own textarea.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        field,
        "max-h-[40vh] min-h-20 resize-none py-2 leading-normal [field-sizing:content]",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Textarea, field as fieldClassName };
