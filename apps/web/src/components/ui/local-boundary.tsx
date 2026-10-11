import { useToast } from "./toast.tsx";
import { RecoverableBoundary } from "./recoverable-boundary.tsx";
import type { ComponentProps } from "react";

/** Keep a broken region recoverable without unmounting its neighbours. */
export function LocalBoundary(props: Omit<ComponentProps<typeof RecoverableBoundary>, "report">) {
  const toast = useToast();
  return (
    <RecoverableBoundary
      {...props}
      report={(retry) =>
        toast.error({
          title: `Couldn't show ${props.label}`,
          actionProps: { children: "Try again", onClick: retry },
        })
      }
    />
  );
}
