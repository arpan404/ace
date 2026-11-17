import SwiftUI

/// The home screen's tabs. `compose` is the detached compose button on iOS 27, never a page.
enum InboxTab: Hashable { case threads, chats, spade, review, search, compose }

/// The home tabs in their order (Projects · Chats · Spade · Code review · Search, then compose) and
/// what each is called, in the web rail's words: the thread list is Projects there. Code review is the web rail's place for pull requests and issues. Spade, ace's cloud agent, is hidden until it launches: turning `showsSpade` on puts
/// its tab back in its slot between Chats and Search, and its glyph in the iPad sidebar, with
/// nothing else to lay out again.
enum HomeTabs {
    /// Spade's tab, off until Spade launches.
    static let showsSpade = false

    /// The places the tab bar (and the iPad sidebar's foot) switches between, in order.
    static var switchable: [InboxTab] { [.threads, .chats] + (showsSpade ? [.spade] : []) + [.review, .search] }

    static func title(_ tab: InboxTab) -> String {
        switch tab {
        case .threads: "Projects"
        case .chats: "Chats"
        case .spade: "Spade"
        case .review: "Code review"
        case .search: "Search"
        case .compose: "New thread"
        }
    }

    /// Spade's tab glyph, until Spade launches with its own mark in the bar.
    static let spadeSymbol = "suit.spade"

    /// The tab bar's glyph: ace's own icon (the one the iPad sidebar draws) at the bar's glyph
    /// size, filled while its tab is chosen, as the system's tabs fill theirs.
    static func tabImage(_ tab: InboxTab, chosen: Bool) -> String {
        "tab-\(icon(tab).rawValue)\(chosen ? "-fill" : "")"
    }

    /// The iPad sidebar's glyph, the web rail's own.
    static func icon(_ tab: InboxTab) -> AceIcon.Name {
        switch tab {
        case .threads: .folderSimple
        case .chats: .chats
        case .spade: .sparkle
        case .review: .gitPullRequest
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
        case .review: "review"
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
