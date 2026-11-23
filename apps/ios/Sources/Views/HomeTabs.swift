import SwiftUI

/// The home screen's tabs. `compose` is New thread's slot in a phone's tab bar (the search role's round button) and its glyph in a regular window's list top bars, never a page.
enum InboxTab: Hashable { case threads, chats, spade, review, search, compose }

/// The home tabs in their order (Projects · Chats · Spade · Code review · Search, then compose) and
/// what each is called, in the web rail's words: the thread list is Projects there. Code review is
/// the web rail's place for pull requests and issues: a tab in a regular window, opened from the
/// Projects list's top bar on every device, so neither the phone's tab bar nor the iPad sidebar's
/// foot holds it and the lists keep their room. Spade, ace's assistant, has its tab only while a
/// paired machine shows it (Settings › Beta's Spade, ADR 0139), as the web rail shows its place:
/// in its slot after Chats, and its glyph in the iPad sidebar, with nothing else to lay out again.
enum HomeTabs {
    /// The places the iPad sidebar's foot switches between, in order, as a phone's tab bar holds
    /// them: Code review opens from the Projects list's top bar instead.
    static func footPlaces(spade: Bool) -> [InboxTab] { [.threads, .chats] + (spade ? [.spade] : []) + [.search] }

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

    /// The system tab bar uses the same glyph for both selection states.
    static func tabImage(_ tab: InboxTab) -> String {
        "tab-\(icon(tab).rawValue)"
    }

    /// The shared glyph for each place. The phone uses Sparkle for Spade.
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
}

extension EnvironmentValues {
    /// A paired machine shows Spade, so its tab and sidebar glyph are there (`HomeTabs`).
    @Entry var showsSpade = false
}

extension TabContent {
    /// A home place's tab on the system's bar: `tab.<id>` for UI tests, and a badge counting what
    /// needs the person there while it isn't showing (0 shows none), read as "Needs you".
    func placeTab(_ place: InboxTab, waiting: Int) -> some TabContent<TabValue> {
        badge(waiting)
            .accessibilityValue(waiting > 0 ? Text("Needs you") : Text(""))
            .accessibilityIdentifier("tab.\(HomeTabs.identifier(place))")
    }
}
