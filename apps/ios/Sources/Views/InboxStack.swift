import SwiftUI

/// What the inbox chrome's controls open.
struct InboxChromeActions {
    let settings: () -> Void
    let machines: () -> Void
    /// Nil while every paired machine is view-only: nothing could start.
    let compose: (() -> Void)?
}

/// The inbox's one navigation stack, quiet as the web's task list: the "ace" wordmark (or a
/// connection problem) and Search in a plain bar; Settings, the scope ("All projects ⌄") and
/// New thread in the bottom toolbar, where the thumb is. No tab bar and nothing floating.
/// Search is the system's own: the list turns into results while there is a query.
struct InboxStack<Destination: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [String]
    @Binding var scope: InboxScope
    @Binding var shelves: InboxShelves
    let actions: InboxRowActions
    let chrome: InboxChromeActions
    @ViewBuilder let destination: (String) -> Destination
    @State private var query = ""
    @State private var searching = false

    /// The scope: a row shows when its machine, project and pull request match.
    private func includes(_ key: InboxKey) -> Bool {
        if !scope.machine.isEmpty && key.machineId != scope.machine { return false }
        guard let row = inbox.row(key) ?? inbox.pending(key).flatMap({ inbox.row(InboxKey(machineId: key.machineId, id: $0.threadId)) }) else {
            return scope.project.isEmpty && !scope.pulls
        }
        if !scope.project.isEmpty && row.workspaceId != scope.project { return false }
        return !scope.pulls || row.pr?.inReview == true
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    InboxList(inbox: inbox, includes: includes, pulls: scope.pulls, shelves: $shelves, actions: actions, compose: chrome.compose)
                        .refreshable { await refresh() }
                } else {
                    InboxSearchList(inbox: inbox, query: query, includes: includes, open: actions.open)
                }
            }
            .modifier(InboxSearchField(query: $query, searching: $searching))
            .modifier(HardBottomEdge())
            .navigationBarTitleDisplayMode(.inline)
            // Opaque bars on the page colour: the list never shows through its chrome.
            .toolbarBackground(AceTheme.Colours.background, for: .navigationBar, .bottomBar)
            .toolbarBackgroundVisibility(.visible, for: .bottomBar)
            .toolbar { toolbar }
            .navigationDestination(for: String.self) { id in
                destination(id).toolbar(.hidden, for: .bottomBar)
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        plain(.topBarLeading) {
            InboxTitle(problem: InboxConnectionProblem.of(inbox), openMachines: chrome.machines)
        }
        plain(.topBarTrailing) {
            Button { searching = true } label: { icon(.magnifyingGlass) }
                .accessibilityLabel("Search").accessibilityIdentifier("inbox.search")
        }
        plain(.bottomBar) {
            Button(action: chrome.settings) { icon(.gear) }
                .accessibilityLabel("Settings").accessibilityIdentifier("inbox.settings")
        }
        if #available(iOS 26, *) { ToolbarSpacer(.flexible, placement: .bottomBar) } else { ToolbarItem(placement: .bottomBar) { Spacer() } }
        plain(.bottomBar) { InboxScopeMenu(inbox: inbox, scope: $scope) }
        if #available(iOS 26, *) { ToolbarSpacer(.flexible, placement: .bottomBar) } else { ToolbarItem(placement: .bottomBar) { Spacer() } }
        plain(.bottomBar) {
            if let compose = chrome.compose {
                Button(action: compose) { icon(.notePencil) }
                    .accessibilityLabel("New thread").accessibilityIdentifier("inbox.compose")
            }
        }
    }

    private func plain<Content: View>(_ placement: ToolbarItemPlacement, @ViewBuilder _ content: @escaping () -> Content) -> PlainToolbarItem<Content> {
        PlainToolbarItem(placement: placement, content: content)
    }
    private func icon(_ name: AceIcon.Name) -> some View {
        AceIcon(name, size: 22, relativeTo: .title3)
            .foregroundStyle(AceTheme.Colours.foreground)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }

    /// The list is live; a pull asks every machine that isn't ready to reconnect now.
    private func refresh() async {
        let waiting = inbox.sessions.filter { $0.client.connection != "ready" }
        guard !waiting.isEmpty else { return }
        for session in waiting { session.client.retry() }
        for _ in 0..<20 where waiting.contains(where: { $0.client.connection != "ready" }) { try? await Task.sleep(for: .milliseconds(100)) }
    }
}

/// Rows end crisply at the bottom toolbar on iOS 26 instead of fading under it.
private struct HardBottomEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) { content.scrollEdgeEffectStyle(.hard, for: .bottom) } else { content }
    }
}

/// A bar item drawn flat on the page, without iOS 26's glass capsule behind it.
private struct PlainToolbarItem<Content: View>: ToolbarContent {
    let placement: ToolbarItemPlacement
    let content: () -> Content
    @ToolbarContentBuilder var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: placement, content: content).sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: placement, content: content)
        }
    }
}

/// The system search field, shown only once Search asks for it and gone again when the person
/// cancels, so the inbox opens on its rows rather than an empty field.
private struct InboxSearchField: ViewModifier {
    @Binding var query: String
    @Binding var searching: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        Group {
            if shown {
                content.searchable(text: $query, isPresented: $searching, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search threads and messages")
            } else {
                content
            }
        }
        .onChange(of: searching) { _, now in
            if now { shown = true } else { query = ""; shown = false }
        }
    }
}
