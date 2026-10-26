import SwiftUI

/// How the Threads tab lays out its list and the open thread, decided from the window alone: its
/// horizontal size class and width, never the device, the screen or its orientation. A phone, the
/// folded iPhone Duo and a narrow iPad window are compact: the list and the thread stack. A wide
/// iPad window and the unfolded Duo are regular: the list stays beside the thread. In a compact
/// window the list is a drawer over the open thread (`ThreadDrawer`).
///
/// The open thread and its pushed pages are one path in every layout. The split shows its first
/// page as the list's selection and the rest on the detail column's own stack, so a window that
/// narrows or widens (an iPad resize, the Duo folding) keeps the same thread and pages.
enum ThreadColumns {
    /// A regular window narrower than this keeps the thread full width and shows the list over
    /// it: a list beside the thread would leave the transcript too narrow to read.
    static let sideBySideMinimum: CGFloat = 700
    /// The list column beside the thread: wide enough for the header (the wordmark clear of the
    /// window's controls, then Settings, Search and New thread) and the three-line rows.
    static let listWidth = (min: CGFloat(340), ideal: CGFloat(384), max: CGFloat(420))

    /// Whether the list sits beside the open thread.
    static func sideBySide(_ sizeClass: UserInterfaceSizeClass?, width: CGFloat) -> Bool {
        sizeClass == .regular && width >= sideBySideMinimum
    }

    /// Which columns a regular window shows. Side by side, both; too narrow for both, the thread
    /// alone once one is open (the list slides over it from the toolbar), the list until then.
    static func visibility(_ sizeClass: UserInterfaceSizeClass?, width: CGFloat, open: Bool) -> NavigationSplitViewVisibility {
        sideBySide(sizeClass, width: width) || !open ? .all : .detailOnly
    }

    /// The thread the list shows as open.
    static func selection(_ path: [InboxRoute]) -> InboxKey? { path.first?.thread }
    /// The pages pushed over the open thread in the detail column: child threads and the like.
    static func detail(_ path: [InboxRoute]) -> [InboxRoute] { Array(path.dropFirst()) }
    /// The whole path once the detail column's own stack changed.
    static func path(_ path: [InboxRoute], detail: [InboxRoute]) -> [InboxRoute] {
        guard let first = path.first else { return [] }
        return [first] + detail
    }

    /// Whether the sidebar carries Threads, Pull requests and New thread in place of the tab bar.
    static func sidebarHoldsTabs(_ sizeClass: UserInterfaceSizeClass?) -> Bool { sizeClass == .regular }

    /// How far the list's header (the wordmark) steps in from where the bar puts it: clear of
    /// the sidebar panel's rounded corner, and of the window's controls (the red, yellow and green
    /// dots) when the window has them, which the bar alone sets it right against.
    static func headerLead(_ sizeClass: UserInterfaceSizeClass?, windowControls: CGFloat) -> CGFloat {
        if windowControls > 0 { return AceTheme.Spacing.md }
        return sidebarHoldsTabs(sizeClass) ? AceTheme.Spacing.sm : AceTheme.Spacing.none
    }

    /// The tab bar shows only in a compact window, and steps aside while it shows a page.
    static func showsTabBar(_ sizeClass: UserInterfaceSizeClass?, path: [InboxRoute]) -> Bool {
        !sidebarHoldsTabs(sizeClass) && path.isEmpty
    }

    /// The thread before or after `current` in the list's order (`step` -1 or 1); the first or
    /// last when none is open. Nil past either end, or with nothing listed.
    static func neighbour(of current: InboxKey?, in order: [InboxKey], step: Int) -> InboxKey? {
        guard let current, let index = order.firstIndex(of: current) else {
            return step < 0 ? order.last : order.first
        }
        let next = index + step
        return order.indices.contains(next) ? order[next] : nil
    }

    /// The threads in the order the list shows them: its sections, then the Snoozed and Settled
    /// shelves only while they are open. Unsent rows open the thread they belong to.
    static func order(_ sections: [MergedInbox.Section], shelves: InboxShelves, thread: (InboxKey) -> InboxKey?) -> [InboxKey] {
        let shelved = ["snoozed", "settled"]
        let open = sections.filter { !shelved.contains($0.key) }
            + (shelves.snoozed ? sections.filter { $0.key == "snoozed" } : [])
            + (shelves.settled ? sections.filter { $0.key == "settled" } : [])
        var seen = Set<InboxKey>()
        return open.flatMap { $0.rows.compactMap(thread) }.filter { seen.insert($0).inserted }
    }
}

/// The transcript and composer's widest line: comfortable reading on an iPad or a landscape phone,
/// no limit below it.
enum ReadingColumn {
    static let maxWidth: CGFloat = 720

    /// Where the composer and the request card above it sit in the reading column. A regular
    /// window gives both the transcript's own margin, so card, composer and text share one
    /// column's edges, and lifts the composer clear of the window's resize corner. A phone keeps
    /// its composer close to the edge and the card tucked narrower than it.
    struct Bar: Equatable {
        /// From the column's edge to the composer's glass.
        let composer: CGFloat
        /// From the column's edge to the card's glass.
        let card: CGFloat
        /// Under the composer, above the bottom safe area.
        let bottom: CGFloat
    }
    /// The transcript's rows sit this far in from the column's edges.
    static let textMargin = AceTheme.Spacing.xl
    static func bar(_ sizeClass: UserInterfaceSizeClass?) -> Bar {
        sizeClass == .regular
            ? Bar(composer: textMargin, card: textMargin, bottom: AceTheme.Spacing.lg)
            : Bar(composer: AceTheme.Spacing.md, card: AceTheme.Spacing.md + AceTheme.Spacing.lg, bottom: AceTheme.Spacing.sm)
    }
}
