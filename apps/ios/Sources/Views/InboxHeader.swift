import SwiftUI

/// The machines the inbox can't reach right now, as the header names them. Built from each
/// session's own connection state; the rows keep their own confirmation and never read fresh.
struct InboxConnectionProblem: Hashable {
    /// The machine's name when one is out, else how many.
    let text: String
    /// Still trying (spinner) rather than out of reach (wifi.slash).
    let trying: Bool
    /// `inbox.connection.<name>` when machines are named, for UI tests.
    let identifier: String

    @MainActor static func of(_ inbox: MachineInbox) -> InboxConnectionProblem? {
        let out = inbox.sessions.filter { $0.client.connection != "ready" }
        guard let first = out.first else { return nil }
        let trying = out.allSatisfy { ["connecting", "starting", "reconnecting"].contains($0.client.connection) }
        let named = inbox.showsMachineNames ? inbox.name(first.hostId) : "your machine"
        let subject = out.count > 1 ? "\(out.count) machines" : named
        let fatal = out.contains { $0.client.connection == "fatal" }
        // Stopped only to be asked for its machine code: reachable, waiting for the person.
        let asking = out.allSatisfy { $0.client.connection == "fatal" && $0.client.machineCodeAsk != nil }
        let text = asking ? (out.count > 1 ? "\(subject) need their machine codes"
                             : inbox.showsMachineNames ? "\(named) needs its machine code" : "Your machine needs its machine code")
            : fatal ? "Can't reach \(subject)"
            : out.allSatisfy({ ["connecting", "starting"].contains($0.client.connection) }) ? "Connecting to \(subject)"
            : trying ? "Reconnecting to \(subject)"
            : out.count > 1 ? "\(subject) offline" : inbox.showsMachineNames ? "\(named) is offline" : "Your machine is offline"
        let identifier = inbox.showsMachineNames && out.count == 1 ? "inbox.connection.\(inbox.name(first.hostId))" : "inbox.connection"
        return InboxConnectionProblem(text: text, trying: trying && !fatal, identifier: identifier)
    }
}

/// The scope the Threads title's menu chooses: the machine (while more than one is paired), the
/// project, and how the machines sort threads. Each is a native picker with checkmarks.
struct InboxFilters: View {
    let inbox: MachineInbox
    @Binding var machine: String
    @Binding var project: String

    private var projects: [ProjectFilterRow] { inbox.projectRows(machine: machine) }

    /// The scope in words, under the title: "All projects", "ace", "Studio · ace".
    var subtitle: String {
        let projectName = ProjectFilterGroups.group(for: project, in: inbox.projectRows(machine: ""))?.name ?? "All projects"
        guard inbox.showsMachineNames else { return projectName }
        return "\(machine.isEmpty ? "All machines" : inbox.name(machine)) · \(projectName)"
    }

    /// Its threads, and the machines it is on while more than one is paired.
    private func detail(_ row: ProjectFilterRow) -> String {
        let threads = row.threads == 1 ? "1 thread" : "\(row.threads) threads"
        guard inbox.showsMachineNames else { return threads }
        return "\(threads) · \(row.machines.map(inbox.name).joined(separator: ", "))"
    }

    var body: some View {
        if inbox.showsMachineNames {
            Picker("Machine", selection: $machine) {
                Text("All machines").tag("")
                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
            }
        }
        // The stored choice may be an older bare id: the row it names reads as chosen.
        Picker("Project", selection: Binding(get: { ProjectFilterGroups.shown(for: project, in: projects, across: inbox.projectRows(machine: ""))?.id ?? project },
                                             set: { project = $0 })) {
            Text("All projects").tag("")
            ForEach(projects) { row in
                VStack(alignment: .leading) { Text(row.name); Text(detail(row)) }.tag(row.id)
            }
        }
        sortPicker
    }

    /// Sort threads, the machines' own setting (the web's Settings › Agents › Sort threads), under
    /// the projects. Choosing saves it on every machine this phone can act on.
    @ViewBuilder private var sortPicker: some View {
        let choices = inbox.sortChoices
        if !choices.isEmpty && inbox.sessions.contains(where: { $0.client.canOperate }) {
            Section("Sort threads") {
                Picker("Sort threads", selection: Binding(
                    get: { inbox.sortBy(in: machine) ?? "activity" },
                    set: { choice in Task { await inbox.setSort(choice) } })) {
                    ForEach(choices) { Text($0.label).tag($0.id) }
                }
            }
            .accessibilityIdentifier("inbox.sort")
        }
    }
}

/// The inbox's glass chip: a menu's current choice and a chevron. The Pull requests and Issues
/// tab uses the same chips.
struct InboxChip: View {
    let title: String
    /// The segmented control's height beside it, grown with the words' text style.
    @ScaledMetric(relativeTo: .subheadline) private var height = AceDesign.Size.segment
    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            Text(title).lineLimit(1)
            AceIcon(.caretDown, size: AceDesign.Size.glyphSmall, weight: .bold, relativeTo: .caption)
        }
        .aceFont(AceDesign.TextRole.segment)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .padding(.horizontal, AceDesign.Space.row)
        // The segmented control's height beside it, taking taps over 44.
        .frame(height: height)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .tapBand(drawn: height)
    }
}

extension View {
    /// Pins `bar` under the navigation title, as Mail and Files pin a control there: on iOS 26 a
    /// system bar with the hard scroll-edge effect Apple uses under a pinned control, so rows blur
    /// away under the title and the bar together and nothing prints through; iOS 18 gives it the
    /// page colour.
    func pinnedTopBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(PinnedTopBar(bar: bar(), list: nil))
    }

    /// `pinnedTopBar` over content that swaps one list for another: each new `list` starts at the
    /// top, so the edge hides again.
    func pinnedTopBar<Bar: View>(resetOn list: some Hashable, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(PinnedTopBar(bar: bar(), list: AnyHashable(list)))
    }
}

/// `pinnedTopBar`. The edge shows once rows pass under the bar: at rest it would blur the large
/// title above it. It turns on only after the large title has handed over to the small one and
/// off only back near the top, so the wobble of the scroll position during that hand-over can't
/// flip it every frame, and only while the person scrolls (`ScrollEdgeHold`).
private struct PinnedTopBar<Bar: View>: ViewModifier {
    let bar: Bar
    /// The list showing, where the content swaps lists; nil where it never does.
    let list: AnyHashable?
    @State private var hold = ScrollEdgeHold()
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .onScrollGeometryChange(for: CGFloat.self) { Self.offset($0) } action: { _, offset in
                    change { $0.moved(to: offset) }
                }
                .onScrollPhaseChange { _, phase, context in
                    change { $0.phase(scrolling: phase != .idle, offset: Self.offset(context.geometry)) }
                }
                .onChange(of: list) { change { $0.reset() } }
                .scrollEdgeEffectStyle(.hard, for: .top)
                .scrollEdgeEffectHidden(!hold.shown, for: .top)
                .safeAreaBar(edge: .top, spacing: AceTheme.Spacing.none) { bar }
        } else {
            content.safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { bar.background(AceTheme.Colours.background) }
        }
    }

    private static func offset(_ geometry: ScrollGeometry) -> CGFloat { geometry.contentOffset.y + geometry.contentInsets.top }

    /// Writes the hold only when it changes: every write lays the page out again.
    private func change(_ step: (inout ScrollEdgeHold) -> Void) {
        var next = hold
        step(&next)
        if next != hold { hold = next }
    }
}

/// Whether a pinned bar's scroll edge shows, from how far the list has scrolled: on past `on`
/// (about a large title's height, so the title has collapsed), off again only under `off`. The
/// offset moves it only while the person scrolls, and where a scroll comes to rest: layout moves
/// the list too (a large title settling over a short list nudges it back and forth), and
/// following those would lay the page out again on every pass, without end. Pure.
struct ScrollEdgeHold: Equatable {
    static let on: CGFloat = 52
    static let off: CGFloat = 8
    private(set) var shown = false
    private(set) var scrolling = false

    /// The list moved, by the person or by layout.
    mutating func moved(to offset: CGFloat) {
        if scrolling { follow(offset) }
    }

    /// The person started or stopped scrolling, with the list at `offset`.
    mutating func phase(scrolling: Bool, offset: CGFloat) {
        self.scrolling = scrolling
        follow(offset)
    }

    /// Another list took the page, at its top.
    mutating func reset() { shown = false }

    private mutating func follow(_ offset: CGFloat) {
        if shown { if offset < Self.off { shown = false } } else if offset > Self.on { shown = true }
    }
}
