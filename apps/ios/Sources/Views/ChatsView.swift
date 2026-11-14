import SwiftUI

/// The Chats filter's words: a chat shows when every word typed is in its title, ignoring case
/// and accents.
enum ChatsFilter {
    static func matches(_ title: String, query: String) -> Bool {
        let fold = { (text: String) in text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let haystack = fold(title)
        return fold(query).split(whereSeparator: \.isWhitespace).allSatisfy { haystack.contains($0) }
    }
}

/// What the Chats tab's rows and empty state ask of the inbox.
struct ChatsActions {
    let open: (InboxKey) -> Void
    let newChat: () -> Void
    let rename: (InboxKey) -> Void
}

/// The Chats tab (ADR 0099), beside Inbox, Snoozed and Settled: plain chats from every paired
/// machine, grouped by each machine's runtime (`chatSections`: Active, then Today, Yesterday,
/// Previous 7 days, Earlier) and merged by rank, in the title's scope. Section labels over
/// one-line rows, each with its single status mark. A row's menu (long press) and swipes offer
/// the chat menu (`chatMenu`): Rename, Pin or Unpin, Move to project and Delete, in the shared
/// words. A chat opens in the thread view on the list's own stack.
struct ChatsList: View {
    @Bindable var inbox: MachineInbox
    /// The title's scope: a row shows when its machine and project match.
    let includes: (InboxKey) -> Bool
    /// Whether the scope takes all of a machine's chats (`MergedInbox.Section.scoped`).
    let whole: (String) -> Bool
    /// The scope in words while it narrows the list ("ace"), else nil.
    let scope: String?
    /// What the tab says with nothing to list and no scope.
    let empty: String
    let searching: Bool
    /// The filter typed over the list; empty shows every chat in the scope.
    var query = ""
    let actions: ChatsActions
    @Environment(\.threadOrganizer) private var organizer

    var body: some View {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let sections = inbox.mergedChats.sections.compactMap { section in
            // Filtering counts only the chats it can read: unloaded ones never hold a section open.
            text.isEmpty ? section.scoped(includes, whole: whole)
                : section.scoped({ key in includes(key) && ChatsFilter.matches(inbox.row(key)?.title ?? "", query: text) },
                                 whole: { _ in false })
        }
        Group {
            if sections.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.rows, id: \.self) { key in
                                if let row = inbox.row(key) { item(key, row) }
                            }
                        } header: {
                            Text(section.label)
                                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.subtleForeground)
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
            // Named by machine and chat, as the Threads list's rows are: two machines may share an id.
            .accessibilityIdentifier(inbox.showsMachineNames ? "chat.\(key.machineId).\(row.id)" : "chat.\(row.id)")
            .listRowInsets(EdgeInsets(top: 0, leading: AceDesign.Size.listInset, bottom: 0, trailing: AceDesign.Size.listInset))
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
    @ViewBuilder private var emptyState: some View {
        if searching || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            EmptyState.search(query)
        } else if !inbox.anyLoaded {
            SkeletonRows(count: 4, label: "Loading chats")
                .frame(maxHeight: .infinity, alignment: .top)
        } else {
            EmptyState(icon: .chatCircle, title: scope.map { "No chats in \($0)" } ?? empty) {
                if scope == nil && inbox.canStartThreads { Button("New chat", action: actions.newChat) }
            }
            .frame(maxHeight: .infinity)
        }
    }
}

/// One chat: the shared one-line row (`InboxLineRow`) ending with its status mark. Semibold
/// while it needs the person; a settled chat's title is subtle, keeping its mark while unread.
private struct ChatRow: View {
    let row: ThreadRow
    var body: some View {
        let look = row.look
        InboxLineRow(row: row, end: .status, dimmed: look?.settled == true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([row.title, look?.meaning, look?.unread == true ? "unread" : nil].compactMap { $0 }.joined(separator: ", "))
    }
}
