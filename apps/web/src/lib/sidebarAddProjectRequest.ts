export const SIDEBAR_ADD_PROJECT_REQUEST_EVENT = "ace:sidebar-add-project-request";

export function requestSidebarAddProject(): void {
  window.dispatchEvent(new Event(SIDEBAR_ADD_PROJECT_REQUEST_EVENT));
}
