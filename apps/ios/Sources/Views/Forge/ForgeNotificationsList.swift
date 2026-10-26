import SwiftUI

/// The person's GitHub notifications (the web's Inbox): unread first by default, newest first,
/// each with its subject's state, number and title, then its repository and why it arrived. A
/// pull request or issue opens its page here and marks it read; anything else opens GitHub.
/// Swipe to mark done or read; the menu also unsubscribes. A write GitHub didn't confirm says so,
/// and Send again is the person's to press.
struct ForgeNotificationsList: View {
    let client: ClientModel
    let machineId: String
    let project: String
    let filter: NotificationsFilter
    let query: String
    let open: (ForgeRoute) -> Void
    @State private var list: ForgeNotifications?
    @State private var failure: String?
    @State private var screens = 1
    @State private var loading = false
    @State private var unconfirmed: (action: String, id: String, message: String)?
    @State private var message: String?
    @Environment(\.openURL) private var openURL

    init(client: ClientModel, machineId: String, project: String, filter: NotificationsFilter, query: String, open: @escaping (ForgeRoute) -> Void) {
        self.client = client
        self.machineId = machineId
        self.project = project
        self.filter = filter
        self.query = query
        self.open = open
        _list = State(initialValue: client.kept(ClientModel.forgeNotificationsRead(project: project, filter: filter), as: ForgeNotifications.self))
    }

    private var request: [String: Any] { ClientModel.forgeNotificationsRead(project: project, filter: filter, screens: screens) }
    /// The search field narrows what is shown by title or repository.
    private var rows: [ForgeNotifications.Row] {
        let rows = list?.rows ?? []
        let typed = query.trimmingCharacters(in: .whitespaces)
        guard !typed.isEmpty else { return rows }
        return rows.filter { $0.title.localizedCaseInsensitiveContains(typed) || $0.repository.localizedCaseInsensitiveContains(typed) }
    }

    var body: some View {
        ForgeListFrame(loaded: list != nil, empty: rows.isEmpty, emptyTitle: filter.all ? "No notifications" : "You're all caught up",
                       icon: .bell, failure: failure, stale: false, hasMore: list?.more ?? false, loading: loading,
                       refresh: { await load() }, more: { screens += 1 }) {
            if let unconfirmed {
                HStack {
                    Text(unconfirmed.message).meta().lineLimit(2)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Send again") { write(unconfirmed.action, unconfirmed.id) }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .accessibilityIdentifier("forge.inbox.again")
                }
                .padding(.horizontal, AceTheme.Spacing.md)
                .forgeRowChrome()
            } else if let message {
                Text(message).meta(AceTone.failed.text).padding(.horizontal, AceTheme.Spacing.md).forgeRowChrome()
            }
            ForEach(rows) { row in
                Button { tap(row) } label: { ForgeNotificationRow(row: row) }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("forge.inbox.\(row.id)")
                    .forgeRowChrome()
                    .swipeActions(edge: .trailing) {
                        if client.canOperate { Button("Done") { write("done", row.id) }.tint(AceTheme.Colours.foreground) }
                    }
                    .swipeActions(edge: .leading) {
                        if client.canOperate, row.unread { Button("Mark read") { write("read", row.id) } }
                    }
                    .contextMenu {
                        if client.canOperate {
                            if row.unread { Button("Mark read", ace: .envelopeOpen) { write("read", row.id) } }
                            Button("Mark done", ace: .check) { write("done", row.id) }
                            Button("Unsubscribe", ace: .bellSlash) { write("unsubscribe", row.id) }
                        }
                        if let link = URL(string: row.url) { Button("Open on GitHub", ace: .arrowSquareOut) { openURL(link) } }
                    }
            }
        }
        .task(id: "\(project)|\(filter)|\(screens)|\(client.readGeneration(request))") { await load() }
    }

    private func tap(_ row: ForgeNotifications.Row) {
        if row.unread, client.canOperate { write("read", row.id) }
        if let opens = row.opens {
            open(ForgeRoute(kind: opens.kind == "pull" ? .pull : .issue, machineId: machineId, project: project, number: opens.number, repository: opens.repository))
        } else if let link = URL(string: row.url) {
            openURL(link)
        }
    }

    private func write(_ action: String, _ id: String) {
        Task {
            let outcome = await client.forgeNotificationWrite(project: project, action: action, id: id)
            unconfirmed = outcome.uncertain ? (action, id, outcome.message) : nil
            message = outcome.ok || outcome.uncertain ? nil : outcome.message
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { list = try await client.forgeNotifications(project: project, filter: filter, screens: screens); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}

/// One notification: the unread dot, the subject's glyph, number and title, then repository and
/// reason, and its age.
struct ForgeNotificationRow: View {
    let row: ForgeNotifications.Row

    var body: some View {
        HStack(alignment: .top, spacing: AceTheme.Spacing.sm) {
            Circle().fill(row.unread ? AceTheme.Colours.accent : .clear)
                .frame(width: 6, height: 6).padding(.top, 8)
                .accessibilityHidden(true)
            glyph.padding(.top, 2)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    if let number = row.number {
                        Text(verbatim: "#\(number)").monospacedDigit().meta(AceTheme.Colours.subtleForeground)
                    }
                    Text(row.title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .fontWeight(row.unread ? .medium : .regular)
                        .foregroundStyle(row.unread ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                        .lineLimit(2)
                }
                Text("\(row.repository) · \(row.reason)").meta()
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if let at = row.updatedAt { ForgeAge(at: at).meta() }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.unread ? "Unread, \(row.title), \(row.repository), \(row.reason)" : "\(row.title), \(row.repository), \(row.reason)")
    }

    @ViewBuilder private var glyph: some View {
        if row.glyph == "pull", let state = row.state { ForgePullGlyph(state: state, merged: row.merged, size: 15) }
        else if row.glyph == "issue", let state = row.state { ForgeIssueGlyph(state: state, size: 15) }
        else {
            AceIcon(.bell, size: 15, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityLabel(row.type)
        }
    }
}

/// The inbox's choices: Unread or All, Participating only, and one reason.
struct ForgeNotificationsFilterMenu: View {
    @Binding var filter: NotificationsFilter
    let reasons: [ForgeNotifications.Reason]

    var body: some View {
        Menu {
            Picker("Show", selection: $filter.all) {
                Text("Unread").tag(false)
                Text("All").tag(true)
            }
            Toggle("Participating", isOn: $filter.participating)
            Picker("Reason", selection: $filter.reason) {
                Text("Any reason").tag(String?.none)
                ForEach(reasons, id: \.value) { Text($0.label).tag(Optional($0.value)) }
            }
        } label: { InboxChip(title: filter.all ? "All" : "Unread") }
            .accessibilityIdentifier("forge.inbox.filters")
    }
}
