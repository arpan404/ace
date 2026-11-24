import { CaretLeftIcon } from "@ace/icons";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";

/** A page inside the profile panel: a back arrow and its centred title over what it holds. */
export function ProfilePage(props: { title: string; onBack(): void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-[32px_1fr_32px] items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={props.onBack}
          className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground active:bg-active"
        >
          <Icon icon={CaretLeftIcon} size={16} />
        </button>
        <h3 className="truncate text-center text-md font-semibold tracking-heading text-foreground">
          {props.title}
        </h3>
        <span aria-hidden />
      </div>
      {props.children}
    </div>
  );
}
