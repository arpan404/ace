import {
  cloneElement,
  Suspense,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { Tip } from "@/components/ui/tooltip.tsx";

export interface MenuButtonProps {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  tip?: string | undefined;
  children: ReactNode;
  align?: "start" | "end" | undefined;
}

export interface MenuPopupProps extends MenuButtonProps {
  /** Replay a press made before the popup's code arrived, preserving keyboard focus rules. */
  activation?: string | undefined;
}

/** Keep the visible button eager, warming its menu while idle or loading it on a press. */
export function deferredMenuButton(load: () => Promise<ComponentType<MenuPopupProps>>) {
  const popup = deferredComponent(load);
  return function DeferredMenuButton(props: MenuButtonProps) {
    const [ready, setReady] = useState(false);
    const [activation, setActivation] = useState<string>();
    useEffect(() => whenIdle(() => void popup.preload().catch(() => {})), []);
    useEffect(() => {
      if (activation === undefined) return;
      let live = true;
      const finish = () => {
        if (live) setReady(true);
      };
      // A failed import still renders React.lazy so the app's error boundary can handle it.
      void popup.preload().then(finish, finish);
      return () => {
        live = false;
      };
    }, [activation]);
    const trigger = cloneElement(props.trigger, {
      "aria-haspopup": "menu",
      "aria-expanded": false,
      onClick: () => setActivation("click"),
      onKeyDown: (event) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          setActivation(event.key);
        } else {
          props.trigger.props.onKeyDown?.(event);
          if (event.key === "Escape" && !event.defaultPrevented) setActivation(undefined);
        }
      },
    });
    const fallback = props.tip ? (
      <Tip label={props.tip} side="right">
        {trigger}
      </Tip>
    ) : (
      trigger
    );
    if (!ready || activation === undefined) return fallback;
    return (
      <Suspense fallback={fallback}>
        <popup.Component {...props} activation={activation} />
      </Suspense>
    );
  };
}
