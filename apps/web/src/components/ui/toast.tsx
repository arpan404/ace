import { Toast } from "@base-ui/react/toast";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { buttonVariants } from "./button.tsx";

/**
 * Toasts: glass pills at the bottom centre with an optional action (Undo). Queue them from
 * anywhere under <ToastProvider> with `useToast().add({ title, actionProps })`.
 */
function ToastProvider(props: { children: ReactNode }) {
  return (
    <Toast.Provider limit={3} timeout={5000}>
      {props.children}
      <Toast.Portal>
        <Toast.Viewport className="fixed bottom-[22px] left-1/2 z-[115] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "glass rounded-lg text-ui font-medium text-popover-foreground",
        "transition-[opacity,transform] duration-[240ms] ease-spring data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-2 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
      )}
    >
      <Toast.Content className="flex items-center gap-2.5 py-[9px] pr-3 pl-3.5">
        <div className="flex min-w-0 flex-col">
          <Toast.Title />
          <Toast.Description className="text-sm font-normal text-muted-foreground empty:hidden" />
        </div>
        <Toast.Action className={cn(buttonVariants({ size: "sm" }), "ml-1.5 empty:hidden")} />
      </Toast.Content>
    </Toast.Root>
  ));
}

const useToast = Toast.useToastManager;

export { ToastProvider, useToast };
