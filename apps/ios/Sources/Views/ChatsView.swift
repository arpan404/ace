import SwiftUI

/// What the Chats tab asks of the inbox.
struct ChatsActions {
    let open: (InboxKey) -> Void
    let newChat: () -> Void
    let rename: (InboxKey) -> Void
    let settings: () -> Void
    let machines: () -> Void
}

/// The Chats tab (ADR 0099): plain chats with no project, every paired machine's, grouped by
/// each machine's runtime (`chatSections`: Active, then Today, Yesterday, Previous 7 days,
/// Earlier) and merged by rank. Its own search narrows them by title on each runtime; New chat
/// starts one; with more than one machine the title chooses a device. A chat opens in the
/// thread view on this tab's own stack.
struct ChatsStack<Destination: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [InboxRoute]
    let actions: ChatsActions
    @ViewBuilder let destination: (InboxKey) -> Destination
    @State private var query = ""
    @State private var device = ""

    var body: some View {
        NavigationStack(path: $path) {
            ChatsList(inbox: inbox, device: device, searching: !query.trimmingCharacters(in: .whitespaces).isEmpty, actions: actions)
                // The system's large title; with several machines the device under it and its
                // picker in the title's menu.
                .nativeTitle("Chats", subtitle: scopeLine, hasMenu: inbox.showsMachineNames) {
                    Picker("Device", selection: $device) {
                        Text("All devices").tag("")
                        ForEach(inbox.sessions) { session in Text(inbox.name(session.hostId)).tag(session.hostId) }
                    }
                }
                .toolbar { toolbar }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: Text("Search chats"))
                .onChange(of: query) { _, now in for session in inbox.sessions { session.client.searchChats(now) } }
                .navigationDestination(for: InboxRoute.self) { route in
                    if let key = route.thread { destination(key) }
                }
        }
    }

    /// One button: New chat. More (and Settings in it) is the Threads header's.
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if inbox.canStartThreads {
                Button(action: actions.newChat) { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New chat").accessibilityIdentifier("chats.new")
            }
        }
    }

    /// Under the title: what is wrong with the connection, else the device shown (several only).
    private var scopeLine: String? {
        if let problem = InboxConnectionProblem.of(inbox) { return problem.text }
        guard inbox.showsMachineNames else { return nil }
        return device.isEmpty ? "All devices" : inbox.name(device)
    }
}

/// The chats themselves: section labels over one-line rows, each with its single status mark.
/// A row's menu (long press) and swipes offer the chat menu (`chatMenu`): Rename, Pin or Unpin,
/// Move to project and Delete, in the shared words.
private struct ChatsList: View {
    @Bindable var inbox: MachineInbox
    let device: String
    let searching: Bool
    let actions: ChatsActions
    @Environment(\.threadOrganizer) private var organizer

    var body: some View {
        let sections = inbox.mergedChats.sections.compactMap { section in
            section.scoped({ device.isEmpty || $0.machineId == device }, whole: { _ in true })
        }
        Group {
            if sections.isEmpty {
                empty
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.rows, id: \.self) { key in
                                if let row = inbox.row(key) { item(key, row) }
                            }
                        } header: {
                            Text(section.label)
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .textCase(nil)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(AceTheme.Colours.background)
    }

    @ViewBuilder private func item(_ key: InboxKey, _ row: ThreadRow) -> some View {
        let menu = row.chatMenu ?? []
        let labels = inbox.mergedChats.menuLabels.isEmpty ? inbox.merged.menuLabels : inbox.mergedChats.menuLabels
        Button { actions.open(key) } label: { ChatRow(row: row) }
            .buttonStyle(.row)
            .listRowInsets(EdgeInsets(top: 0, leading: AceDesign.Space.related, bottom: 0, trailing: AceDesign.Space.related))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .contextMenu {
                ForEach(menu.filter { $0 != "delete" }, id: \.self) { id in
                    Button("\(labels[id] ?? id)\(id == "rename" ? "…" : "")", ace: id == "rename" ? .pencilSimple : ThreadActionItems.icon(id)) { run(id, key) }
                        .accessibilityIdentifier("chat.action.\(id)")
                }
                if menu.contains("delete") {
                    Divider()
                    Button(role: .destructive) { run("delete", key) } label: { Label(labels["delete"] ?? "Delete", ace: .trash) }
                        .accessibilityIdentifier("chat.action.delete")
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if menu.contains("delete") {
                    Button(role: .destructive) { run("delete", key) } label: { Label(labels["delete"] ?? "Delete", ace: .trash) }
                }
                if menu.contains("move") {
                    Button { run("move", key) } label: { Label(labels["move"] ?? "Move", ace: ThreadActionItems.icon("move")) }
                }
            }
            .swipeActions(edge: .leading) {
                if let pin = menu.first(where: { $0 == "pin" || $0 == "unpin" }) {
                    Button { run(pin, key) } label: { Label(labels[pin] ?? pin, ace: ThreadActionItems.icon(pin)) }
                        .tint(AceTheme.Colours.mutedForeground)
                }
            }
    }

    private func run(_ id: String, _ key: InboxKey) {
        if id == "rename" { actions.rename(key) } else { organizer?.perform(key, id) }
    }

    /// Nothing to list: the shared empty state, worded as the web's Chats panel, or the search's.
    @ViewBuilder private var empty: some View {
        if searching {
            EmptyState.search("")
        } else if !inbox.anyLoaded {
            SkeletonRows(count: 4, label: "Loading chats")
                .frame(maxHeight: .infinity, alignment: .top)
        } else {
            EmptyState(icon: .chatCircle, title: device.isEmpty ? "No chats yet" : "No chats on \(inbox.name(device))") {
                if device.isEmpty && inbox.canStartThreads { Button("New chat", action: actions.newChat) }
            }
            .frame(maxHeight: .infinity)
        }
    }
}

/// One chat: its title on one line and, at the right edge, at most one mark: the row's status
/// icon for a request, a fresh failure, unseen finished work or work still under way. Semibold
/// while it needs the person; a settled chat's title is subtle with no mark.
private struct ChatRow: View {
    let row: ThreadRow
    var body: some View {
        let look = row.look
        HStack(spacing: AceDesign.Space.row) {
            Text(row.title)
                .aceFont(InboxRowType.title, relativeTo: .body)
                .fontWeight(look?.strong == true ? .semibold : .regular)
                .foregroundStyle(look?.settled == true ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                .lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            if let icon = look?.icon, icon != "none", look?.settled != true {
                RowStatusIcon(kind: icon, tone: look?.iconTone ?? "idle", count: look?.count)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(look?.meaning.map { "\(row.title). \($0)" } ?? row.title)
        .accessibilityIdentifier("chat.row")
    }
}
