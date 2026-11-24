import { CaretLeftIcon } from "@ace/icons";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";

/** A page inside the profile panel: a back arrow and its title over what it holds. */
export function ProfilePage(props: { title: string; onBack(): void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center">
        <button
          type="button"
          aria-label="Back"
          onClick={props.onBack}
          className="flex h-8 items-center rounded-full pr-3 pl-2 text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
        >
          <Icon icon={CaretLeftIcon} size={16} />
        </button>
        <h3 className="mx-auto pr-10 text-ui font-medium text-foreground">{props.title}</h3>
      </div>
      {props.children}
    </div>
  );
}
