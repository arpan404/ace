import SwiftUI

/// Home's Code review tab, the web rail's place for pull requests and issues: Pull requests,
/// Issues and Notifications on one page (`ForgeHome`), a pull request or issue pushed on it.
struct CodeReviewTab: View {
    @Bindable var inbox: MachineInbox
    let openThread: (InboxKey) -> Void
    let startThread: () -> Void
    let openMachines: () -> Void
    /// Opens pairing while no computer is paired; nil while that isn't known yet.
    var pair: (() -> Void)?
    @State private var path: [ForgeRoute] = []
    @State private var machine = ""
    @State private var project = ""
    @State private var kind = ForgeKind.pulls
    @State private var query = ""

    var body: some View {
        NavigationStack(path: $path) {
            ForgeHome(inbox: inbox, machine: $machine, project: $project, query: query, kind: $kind,
                      actions: ForgeTabActions(open: { path.append($0) }, openThread: openThread, startThread: startThread),
                      openMachines: openMachines, pair: pair)
                .searchable(text: $query, prompt: Text(kind == .pulls ? "Search pull requests" : kind == .issues ? "Search issues" : "Search notifications"))
                .modifier(ProjectDefaultsHook(inbox: inbox))
                .navigationDestination(for: ForgeRoute.self) { route in
                    ForgePage(inbox: inbox, route: route, open: { path.append($0) }, openThread: openThread,
                              startThread: inbox.canStartThreads ? startThread : nil)
                }
        }
        .tint(AceTheme.Colours.foreground)
    }
}
