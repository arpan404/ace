/**
 * Sidebar primitives adapted from shadcn/ui's Base UI registry (MIT).
 * Source: https://ui.shadcn.com/r/styles/base-nova/sidebar.json
 * Copyright (c) 2023 shadcn
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "./icon-button.tsx";

interface SidebarContextValue {
  state: "expanded" | "collapsed";
  isMobile: boolean;
  toggleSidebar(): void;
}
const SidebarContext = createContext<SidebarContextValue | undefined>(undefined);
function useSidebar() {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used within a SidebarProvider.");
  return value;
}

/** Controlled by the shell's persisted choice and existing shortcut registry. */
function SidebarProvider(
  props: ComponentProps<"div"> & {
    open: boolean;
    onOpenChange(open: boolean): void;
    isMobile: boolean;
    openMobile: boolean;
    onOpenMobileChange(open: boolean): void;
  },
) {
  const { open, onOpenChange, isMobile, openMobile, onOpenMobileChange, className, ...rest } =
    props;
  const value = useMemo<SidebarContextValue>(
    () => ({
      state: open ? "expanded" : "collapsed",
      isMobile,
      toggleSidebar: () => (isMobile ? onOpenMobileChange(!openMobile) : onOpenChange(!open)),
    }),
    [open, onOpenChange, isMobile, openMobile, onOpenMobileChange],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        className={cn("group/sidebar-wrapper relative flex min-h-0 min-w-0 flex-1", className)}
        {...rest}
      />
    </SidebarContext.Provider>
  );
}

/** shadcn's desktop offcanvas gap and panel; mobile remains the app's lazy Sheet. */
function Sidebar(props: { children: ReactNode; className?: string | undefined }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <div
      className="group/sidebar peer text-sidebar-foreground"
      data-state={state}
      data-collapsible={collapsed ? "offcanvas" : ""}
      data-variant="sidebar"
      data-side="left"
      data-slot="sidebar"
    >
      <div
        data-slot="sidebar-gap"
        className="relative h-full w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=offcanvas]/sidebar:w-0 motion-reduce:transition-none"
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          "absolute inset-y-0 left-0 z-10 flex w-(--sidebar-width) border-r border-sidebar-border transition-[left,width] duration-200 ease-linear group-data-[collapsible=offcanvas]/sidebar:left-[calc(var(--sidebar-width)*-1)] motion-reduce:transition-none",
          props.className,
        )}
      >
        <div
          data-slot="sidebar-inner"
          data-sidebar="sidebar"
          aria-hidden={collapsed || undefined}
          inert={collapsed}
          className="sidebar-scroll vibrancy flex size-full min-h-0 flex-col bg-sidebar"
        >
          {props.children}
        </div>
        <SidebarRail />
      </div>
    </div>
  );
}

function SidebarTrigger(props: Omit<ComponentProps<typeof IconButton>, "icon" | "onClick">) {
  const { toggleSidebar } = useSidebar();
  return (
    <IconButton
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      icon={SidebarSimpleIcon}
      onClick={toggleSidebar}
      {...props}
    />
  );
}

/** Canonical rail: pointer toggle; the normal-sized trigger handles keyboard navigation. */
function SidebarRail() {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className="absolute inset-y-0 -right-4 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 hover:after:bg-sidebar-border md:flex group-data-[collapsible=offcanvas]/sidebar:-right-2 group-data-[collapsible=offcanvas]/sidebar:translate-x-0 group-data-[collapsible=offcanvas]/sidebar:cursor-e-resize group-data-[collapsible=offcanvas]/sidebar:after:left-full hover:group-data-[collapsible=offcanvas]/sidebar:bg-sidebar [-webkit-app-region:no-drag]"
    />
  );
}

export { Sidebar, SidebarProvider, SidebarTrigger, SidebarRail, useSidebar };
