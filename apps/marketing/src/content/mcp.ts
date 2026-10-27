import { toolFamilies } from "./product.ts";

/*
 * The full MCP tool reference for /mcp/: every tool in each family with one line on what it does.
 * Families and their order come from product.ts (the home page shows the short version), so the
 * two never list different families.
 */

const describe: Record<string, Record<string, string>> = {
  Agents: {
    delegate:
      "Start one or more agents as threads of their own, on any provider or linked machine.",
    wait: "Wait for delegated agents or other threads to finish, up to a timeout.",
    agents_status: "See where each delegated agent stands.",
    agent_message: "Send a running agent a follow-up.",
    agent_cancel: "Stop an agent that is no longer needed.",
    machines: "List linked machines that agents can work on.",
    models: "List the models each provider offers.",
  },
  Browser: {
    browser_open: "Open a page in ace's browser, or another machine's.",
    browser_snapshot: "Read the page as structured text with references to act on.",
    browser_act: "Click, type, scroll and press keys on the page.",
    browser_find: "Find elements on the page by text or role.",
    browser_screenshot: "Capture the page, an element, or phone, tablet and desktop widths.",
    browser_logs: "Read the console and network log.",
    browser_evaluate: "Run a script in the page and return its value.",
    browser_wait_for: "Wait for text, an element or the network to settle.",
    browser_tabs: "List, open and close tabs.",
  },
  Computer: {
    screen_apps: "List the apps agents may use and the ones in use.",
    screen_state: "Read an app's window through accessibility.",
    screen_act: "Click, type and press keys in an app, in the background.",
  },
  Devices: {
    sim_list: "List iOS Simulators and Android emulators.",
    sim_start: "Boot a device, once you have approved it.",
    sim_ui: "Read the device's screen as a UI tree.",
    sim_act: "Tap, type, swipe and rotate.",
    sim_logs: "Read the device log.",
    sim_screenshot: "Capture the device's screen.",
    sim_stop: "Shut a device down.",
  },
  Threads: {
    context: "Recent threads, uncommitted changes, pull requests and project notes in one read.",
    thread_start: "Start a separate thread in any project.",
    threads_find: "Find threads by text, status or project.",
    thread_read: "Read another thread's work.",
    thread_fork: "Fork a thread to try another approach.",
    thread_link_pr: "Link a pull request to the thread that wrote it.",
    note_add: "Save a project note every future agent will read.",
  },
  Show: {
    html_render: "Show a chart, diagram or interactive page in the thread.",
    image_show: "Show an image in the thread.",
    notify: "Send you a notification.",
  },
  Automations: {
    automation_put: "Create or change a scheduled prompt.",
    automation_run: "Run an automation now.",
    automations_list: "List automations and their last runs.",
  },
};

export interface ToolFamily {
  family: string;
  purpose: string;
  tools: { name: string; does: string }[];
}

export const toolReference: ToolFamily[] = toolFamilies.map(({ family, purpose }) => {
  const tools = describe[family];
  if (!tools) throw new Error(`Describe the ${family} tools in mcp.ts`);
  return {
    family,
    purpose,
    tools: Object.entries(tools).map(([name, does]) => ({ name, does })),
  };
});
