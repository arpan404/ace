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
    /// The thread whose side panel shows: the last thread on the path, the one on screen.
    static func panelScope(_ path: [InboxRoute]) -> InboxKey? { path.last { $0.thread != nil }?.thread }
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

    /// The thread before or after `current` in the list's order (`step` -1 or 1); the first or
    /// last when none is open. Nil past either end, or with nothing listed.
    static func neighbour(of current: InboxKey?, in order: [InboxKey], step: Int) -> InboxKey? {
        guard let current, let index = order.firstIndex(of: current) else {
            return step < 0 ? order.last : order.first
        }
        let next = index + step
        return order.indices.contains(next) ? order[next] : nil
    }

    /// The threads in the order the list shows them: the sections of the open Threads tab.
    /// Unsent rows open the thread they belong to.
    static func order(_ sections: [MergedInbox.Section], tab: String, thread: (InboxKey) -> InboxKey?) -> [InboxKey] {
        let open = sections.filter { $0.tab == tab }
        var seen = Set<InboxKey>()
        return open.flatMap { $0.rows.compactMap(thread) }.filter { seen.insert($0).inserted }
    }
}

/// The transcript and composer's widest line: comfortable reading on an iPad or a landscape phone,
/// no limit below it.
enum ReadingColumn {
    static let maxWidth: CGFloat = 720

    /// Where the transcript, the composer and the strips above it sit in the reading column. They
    /// share one edge: the design language's side margin on a phone, the transcript's wider
    /// reading margin beside the list, where the composer also lifts clear of the window's resize
    /// corner.
    struct Bar: Equatable {
        /// From the column's edge to the transcript's words.
        let text: CGFloat
        /// From the column's edge to the composer's glass and a strip's.
        let composer: CGFloat
        /// Under the composer, above the bottom safe area.
        let bottom: CGFloat
    }
    static func bar(_ sizeClass: UserInterfaceSizeClass?) -> Bar {
        let edge = sizeClass == .regular ? AceTheme.Spacing.xl : AceDesign.Space.margin
        return Bar(text: edge, composer: edge, bottom: sizeClass == .regular ? AceTheme.Spacing.lg : AceTheme.Spacing.sm)
    }
    /// Inside a strip's glass, before its lead mark: the mark sits under the composer's +, and the
    /// strip's words start where the field's words do.
    static let stripLead = ComposerCapsuleMetrics.aboveInset - AceDesign.Size.rowStatus - AceDesign.Space.related
}
