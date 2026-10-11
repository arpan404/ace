export const issueRecord = {
  number: 7,
  title: "Handle retries",
  body: "## Issue context\n\nRetain ordering.",
  html_url: "https://github.com/octo/ace/issues/7",
  user: { login: "author" },
  state: "open",
  labels: [{ name: "bug" }],
  assignees: [{ login: "maintainer" }],
  milestone: { title: "Release" },
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  locked: false,
  future: { retained: true },
};
export function issuePermissions(edit = true) {
  return {
    data: {
      repository: {
        isArchived: false,
        viewerPermission: "READ",
        issue: {
          updatedAt: issueRecord.updated_at,
          viewerCanUpdate: edit,
          viewerCanClose: edit,
          viewerCanReopen: edit,
        },
      },
    },
  };
}
