import { useRef, useState } from "react";
import {
  ArrowBendUpLeftIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ForgeComment, ForgeHiddenReason } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { commentUrl, hiddenReasons } from "./pr-comment-model.ts";

/** What the ⋯ menu of one comment can do; each is absent where it doesn't apply. */
export interface CommentMenuActions {
  quote?: (() => void) | undefined;
  edit?: (() => void) | undefined;
  remove?: (() => void) | undefined;
  hide?: ((reason: ForgeHiddenReason) => void) | undefined;
  unhide?: (() => void) | undefined;
  disabled: boolean;
}

/**
 * A comment's ⋯ menu: Quote reply, Copy link, then Edit and Delete on the viewer's own and
 * Hide or Unhide where GitHub allows it. It shows on hover or focus of its comment.
 */
export function PrCommentMenu(props: {
  comment: ForgeComment;
  prUrl: string;
  actions: CommentMenuActions;
  className?: string | undefined;
}) {
  const { comment, actions } = props;
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  // A quote moves focus to the box it lands in; the menu mustn't take it back.
  const quoting = useRef(false);
  const copy = () => {
    const url = commentUrl(props.prUrl, comment);
    void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("No clipboard"))).then(
      () => toast.success({ title: "Link copied" }),
      () =>
        toast.error({
          title: "Couldn't copy the link",
          description: "Clipboard access is blocked in this browser.",
        }),
    );
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              size="sm"
              icon={DotsThreeIcon}
              label={`Actions for ${comment.author}'s comment`}
              className={cn(
                "opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100",
                props.className,
              )}
            />
          }
        />
        <MenuContent
          align="end"
          finalFocus={() => {
            const quoted = quoting.current;
            quoting.current = false;
            return !quoted;
          }}
        >
          {actions.quote && (
            <MenuItem
              icon={<ArrowBendUpLeftIcon aria-hidden size={16} />}
              disabled={actions.disabled}
              onClick={() => {
                quoting.current = true;
                actions.quote?.();
              }}
            >
              Quote reply
            </MenuItem>
          )}
          <MenuItem icon={<LinkSimpleIcon aria-hidden size={16} />} onClick={copy}>
            Copy link
          </MenuItem>
          {(actions.edit || actions.remove || actions.hide || actions.unhide) && <MenuSeparator />}
          {actions.edit && (
            <MenuItem
              icon={<PencilSimpleIcon aria-hidden size={16} />}
              disabled={actions.disabled}
              onClick={actions.edit}
            >
              Edit
            </MenuItem>
          )}
          {actions.hide && (
            <MenuSub>
              <MenuSubTrigger
                icon={<EyeSlashIcon aria-hidden size={16} />}
                disabled={actions.disabled}
              >
                Hide
              </MenuSubTrigger>
              <MenuContent side="right" align="start" sideOffset={4} aria-label="Hide as">
                {hiddenReasons.map((reason) => (
                  <MenuItem key={reason.value} onClick={() => actions.hide?.(reason.value)}>
                    {reason.label}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuSub>
          )}
          {actions.unhide && (
            <MenuItem
              icon={<EyeIcon aria-hidden size={16} />}
              disabled={actions.disabled}
              onClick={actions.unhide}
            >
              Unhide
            </MenuItem>
          )}
          {actions.remove && (
            <MenuItem
              danger
              icon={<TrashIcon aria-hidden size={16} />}
              disabled={actions.disabled}
              onClick={() => setConfirming(true)}
            >
              Delete
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this comment?</DialogTitle>
            <DialogDescription>It's removed from GitHub for everyone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                actions.remove?.();
              }}
            >
              Delete comment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
