import SwiftUI

/// One pull request or issue page and the pages under it (timeline, files, checks, conflicts,
/// stack, commits), on the machine the route names. Wherever it is pushed (the inbox's stack,
/// More's), `open` pushes the next page on the same stack.
struct ForgePage: View {
    @Bindable var inbox: MachineInbox
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    /// Nil where the phone can't start threads.
    let startThread: (() -> Void)?

    var body: some View {
        content.modifier(ProjectDefaultsHook(inbox: inbox))
    }

    @ViewBuilder private var content: some View {
        if let client = inbox.client(route.machineId) {
            switch route.kind {
            case .pull: ForgePullPageView(client: client, route: route, open: open, openThread: openThread, startThread: startThread)
            case .timeline: ForgeTimelineView(client: client, route: route)
            case .file: ForgeFileView(client: client, route: route)
            case .files: ForgeFilesView(client: client, route: route, open: open)
            case .check: ForgeCheckPageView(client: client, route: route, openThread: openThread, startThread: startThread)
            case .conflicts: ForgeConflictsPageView(client: client, route: route, openThread: openThread)
            case .stack: ForgeStackPageView(client: client, route: route, open: open)
            case .commits: ForgeCommitsView(client: client, route: route, open: open)
            case .issue:
                ForgeIssuePageView(client: client, route: route,
                                   actions: ForgeTabActions(open: open, openThread: openThread, startThread: startThread ?? {}))
            }
        }
    }
}
