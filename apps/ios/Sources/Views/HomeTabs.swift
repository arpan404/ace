import SwiftUI

/// The home screen's tabs. `compose` is the detached compose button on iOS 27, never a page.
enum InboxTab: Hashable { case threads, chats, spade, search, compose }

/// The home tabs in their order (Threads · Chats · Spade · Search, then compose) and what each
/// is called. Spade, ace's assistant, has its tab between Chats and Search and its glyph in the
/// iPad sidebar; turning `showsSpade` off takes both away with nothing else to lay out again.
enum HomeTabs {
    /// Spade's tab (`Views/Spade`), as the web shows Spade's place.
    static let showsSpade = true

    /// The places the tab bar (and the iPad sidebar's foot) switches between, in order.
    static var switchable: [InboxTab] { [.threads, .chats] + (showsSpade ? [.spade] : []) + [.search] }

    static func title(_ tab: InboxTab) -> String {
        switch tab {
        case .threads: "Threads"
        case .chats: "Chats"
        case .spade: "Spade"
        case .search: "Search"
        case .compose: "New thread"
        }
    }

    /// The tab bar's SF Symbol, matched to the web rail's Phosphor glyph (Folders for Threads,
    /// ChatsCircle for Chats).
    static func symbol(_ tab: InboxTab) -> String {
        switch tab {
        case .threads: "folder"
        case .chats: "bubble.left.and.bubble.right"
        case .spade: "suit.spade"
        case .search: "magnifyingglass"
        case .compose: "square.and.pencil"
        }
    }

    /// The tab bar's glyph in its outline form, as the web rail draws it. Handed over as a fixed
    /// image: given the symbol's name, the system bar draws every tab's filled variant.
    static func tabImage(_ tab: InboxTab) -> Image {
        Image(uiImage: UIImage(systemName: symbol(tab)) ?? UIImage())
    }

    /// The iPad sidebar's glyph, the web rail's own.
    static func icon(_ tab: InboxTab) -> AceIcon.Name {
        switch tab {
        case .threads: .folderSimple
        case .chats: .chats
        case .spade: .sparkle
        case .search: .magnifyingGlass
        case .compose: .notePencil
        }
    }

    /// `sidebar.<id>` and `tab.<id>` for UI tests.
    static func identifier(_ tab: InboxTab) -> String {
        switch tab {
        case .threads: "threads"
        case .chats: "chats"
        case .spade: "spade"
        case .search: "search"
        case .compose: "compose"
        }
    }

    /// iOS 27 draws the prominent tab as its own round button at the bar's end: compose lives
    /// there. Before it the detached button is the search tab's, so Search takes it and compose is
    /// a round glass button in the Threads and Chats headers.
    static var composeTab: Bool {
        #if canImport(SwiftUI, _version: 8.0)
        if #available(iOS 27, *) { return true }
        #endif
        return false
    }
}
