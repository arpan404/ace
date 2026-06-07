"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded border border-transparent font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
        lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
        sm: "h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]",
      },
      variant: {
        default:
          "border-primary/20 bg-primary/88 text-primary-foreground supports-[backdrop-filter]:bg-primary/78 supports-[backdrop-filter]:backdrop-blur-sm",
        destructive:
          "border-destructive/25 bg-destructive/92 text-white supports-[backdrop-filter]:bg-destructive/82 supports-[backdrop-filter]:backdrop-blur-sm [button&,a&]:hover:bg-destructive/90",
        error:
          "border-destructive/20 bg-destructive/10 text-destructive-foreground supports-[backdrop-filter]:bg-destructive/14 dark:bg-destructive/16",
        info: "border-info/20 bg-info/10 text-info-foreground supports-[backdrop-filter]:bg-info/14 dark:bg-info/16",
        outline:
          "border-border/55 bg-background/35 text-foreground supports-[backdrop-filter]:border-border/40 supports-[backdrop-filter]:bg-background/28 supports-[backdrop-filter]:backdrop-blur-sm dark:border-border/40",
        secondary:
          "border-border/35 bg-secondary/58 text-secondary-foreground supports-[backdrop-filter]:bg-secondary/48 supports-[backdrop-filter]:backdrop-blur-sm",
        success:
          "border-success/20 bg-success/10 text-success-foreground supports-[backdrop-filter]:bg-success/14 dark:bg-success/16",
        warning:
          "border-warning/20 bg-warning/10 text-warning-foreground supports-[backdrop-filter]:bg-warning/14 dark:bg-warning/16",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge };
