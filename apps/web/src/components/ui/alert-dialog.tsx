import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  MODAL_ACTION_BUTTON_CLASS_NAME,
  MODAL_BACKDROP_CLASS_NAME,
  MODAL_BODY_CLASS_NAME,
  MODAL_CANCEL_BUTTON_CLASS_NAME,
  MODAL_DESCRIPTION_CLASS_NAME,
  MODAL_FOOTER_CLASS_NAME,
  MODAL_HEADER_CLASS_NAME,
  MODAL_SURFACE_CLASS_NAME,
  MODAL_TITLE_CLASS_NAME,
} from "~/components/ui/modalUi";
import { MODAL_LAYER_CLASS_NAME } from "~/components/ui/layers";

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Close
      nativeButton={false}
      render={
        <AlertDialogPrimitive.Backdrop
          data-slot="alert-dialog-overlay"
          className={cn(
            "fixed inset-0 isolate duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            MODAL_BACKDROP_CLASS_NAME,
            MODAL_LAYER_CLASS_NAME,
            className,
          )}
          {...props}
        />
      }
    />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm";
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "group/alert-dialog-content fixed top-1/2 left-1/2 w-[min(100vw-2rem,24rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--panel-radius)] duration-150 outline-none data-[size=sm]:w-[min(100vw-2rem,18rem)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          MODAL_SURFACE_CLASS_NAME,
          MODAL_LAYER_CLASS_NAME,
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(MODAL_HEADER_CLASS_NAME, "min-w-0 text-left", className)}
      {...props}
    />
  );
}

function AlertDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-body"
      className={cn(MODAL_BODY_CLASS_NAME, "min-w-0 pb-4 text-left", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(MODAL_FOOTER_CLASS_NAME, className)}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-3 inline-flex size-7 items-center justify-center rounded-[var(--control-radius)] border border-border/20 bg-muted/15 text-muted-foreground *:[svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(MODAL_TITLE_CLASS_NAME, className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(MODAL_DESCRIPTION_CLASS_NAME, "text-pretty", className)}
      {...props}
    />
  );
}

function AlertDialogAction({ className, size = "sm", ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="alert-dialog-action"
      size={size}
      className={cn(MODAL_ACTION_BUTTON_CLASS_NAME, className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  variant = "ghost",
  size = "sm",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} className={MODAL_CANCEL_BUTTON_CLASS_NAME} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
};
