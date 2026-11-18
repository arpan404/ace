import SwiftUI

/// Where Code review was left: its machine, project and list, each list's filters, the search
/// and the pages pushed on it. The home screen keeps it, so the page opens where the person left
/// it, whether it is the iPad's place or the phone's sheet, closed and opened again.
struct CodeReviewScope: Equatable {
    var machine = ""
    var project = ""
    var kind = ForgeKind.pulls
    var filters = ForgeListFilters()
    var query = ""
    var path: [ForgeRoute] = []
}

/// Home's Code review, the web rail's place for pull requests and issues: Pull requests, Issues
/// and Notifications on one page (`ForgeHome`), a pull request or issue pushed on it. A place of
/// its own in a regular window; on a phone it opens over Projects from the top bar, with Close.
struct CodeReviewTab: View {
    @Bindable var inbox: MachineInbox
    @Binding var scope: CodeReviewScope
    let openThread: (InboxKey) -> Void
    let startThread: () -> Void
    let openMachines: () -> Void
    /// Opens pairing while no computer is paired; nil while that isn't known yet.
    var pair: (() -> Void)?
    /// Closes the page where it opens over the home screen; nil where it is a place of its own.
    var close: (() -> Void)?
    /// The pages it had pushed, held back until its list has been on screen once.
    @State private var held = HeldPath()

    var body: some View {
        NavigationStack(path: Binding(get: { held.shown(scope.path) }, set: { held.write($0, into: &scope.path) })) {
            ForgeHome(inbox: inbox, machine: $scope.machine, project: $scope.project, query: scope.query, kind: $scope.kind,
                      filters: $scope.filters,
                      actions: ForgeTabActions(open: { scope.path.append($0) }, openThread: openThread, startThread: startThread),
                      openMachines: openMachines, pair: pair)
                .searchable(text: $scope.query, prompt: Text(prompt))
                .modifier(ProjectDefaultsHook(inbox: inbox))
                .navigationDestination(for: ForgeRoute.self) { route in
                    ForgePage(inbox: inbox, route: route, open: { scope.path.append($0) }, openThread: openThread,
                              startThread: inbox.canStartThreads ? startThread : nil)
                }
                .toolbar {
                    if let close {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(action: close) { Image(systemName: "xmark") }
                                .accessibilityLabel("Close").accessibilityIdentifier("review.close")
                        }
                    }
                }
        }
        .tint(AceTheme.Colours.foreground)
        .task {
            // Laid out under its pages, the list meets its large title, search and pinned bar
            // only on Back, and their insets then move it on every layout pass, without end.
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { held.release() }
        }
    }

    private var prompt: String {
        switch scope.kind {
        case .pulls: "Search pull requests"
        case .issues: "Search issues"
        case .inbox: "Search notifications"
        }
    }
}

/// A navigation stack opened again on the pages it had pushed: it shows only its root until the
/// root has been laid out on screen, then the pages. Until then the stack's writes (its root
/// alone) never replace the saved pages. Pure.
struct HeldPath {
    private(set) var released = false

    func shown<Page>(_ saved: [Page]) -> [Page] { released ? saved : [] }

    func write<Page>(_ path: [Page], into saved: inout [Page]) {
        if released { saved = path }
    }

    mutating func release() { released = true }
}
