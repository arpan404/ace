import SwiftUI

/// The detail column beside the list while nothing is open (`InboxSplit`): one quiet empty state.
/// While threads in the Inbox need the person it says how many and opens the first of them;
/// otherwise it offers a new thread (or chat) where the person can start one.
struct NothingOpen: View {
    /// What the list holds: `.threads` or `.chats`.
    let list: InboxTab
    /// How many wait on the person in the list's Inbox, and the first of them.
    let waiting: Int
    let first: InboxKey?
    let canStart: Bool
    let open: (InboxKey) -> Void
    let compose: () -> Void

    var body: some View {
        Group {
            if let words = NeedWords.count(waiting), let first {
                EmptyState(icon: .hand, title: words) {
                    Button("Open first") { open(first) }
                        .accessibilityIdentifier("detail.empty.first")
                }
            } else {
                EmptyState(icon: HomeTabs.icon(list), title: chats ? "Pick a chat, or start one" : "Pick a thread, or start one") {
                    if canStart {
                        Button(chats ? "New chat" : "New thread", action: compose)
                            .accessibilityIdentifier("detail.empty.compose")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("detail.empty")
    }

    private var chats: Bool { list == .chats }
}
