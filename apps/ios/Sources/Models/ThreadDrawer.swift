import SwiftUI

/// A compact window's list as a drawer over the open thread (an iPhone, the folded iPhone Duo, a
/// narrow iPad window). The open thread fills the window; its sidebar button or an edge swipe
/// slides the list in from the leading edge, pushing the thread aside, dimmed, with rounded
/// corners. Tapping or swiping the dimmed thread closes the list, and so does picking a thread in
/// it. With nothing open the list fills the window on its own. A regular window keeps the list
/// beside the thread (`ThreadColumns`) and never draws the drawer.
struct ThreadDrawer: Equatable {
    /// What the window shows.
    enum Layout: Equatable {
        /// Regular: the list beside the thread, the split view's own columns.
        case beside
        /// Compact with nothing open: the list fills the window.
        case list
        /// Compact with a page open: the page fills the window, the list a drawer over it.
        case page
    }

    /// Whether the list is out over the open page.
    private(set) var isOpen = false

    static func layout(_ sizeClass: UserInterfaceSizeClass?, path: [InboxRoute]) -> Layout {
        if sizeClass == .regular { return .beside }
        return path.isEmpty ? .list : .page
    }

    /// The sidebar button or a finished edge swipe. Only a page has a drawer to open.
    mutating func open(in layout: Layout) { if layout == .page { isOpen = true } }
    /// A tap or swipe on the dimmed page, the escape gesture, or a thread shown from elsewhere
    /// (a notification, a transfer, the tab changing).
    mutating func close() { isOpen = false }
    /// The sidebar button and its keyboard shortcut: out if it was in, in if it was out.
    mutating func toggle(in layout: Layout) { if isOpen { close() } else { open(in: layout) } }

    /// What a row picked in the list does.
    struct Pick: Equatable {
        /// Whether the row's thread opens. The open thread's own row only closes the drawer:
        /// opening it again would restart its session for nothing.
        let opens: Bool
        /// Whether the list's search ends. In a compact window the list is left for the thread,
        /// so its field must not keep the keyboard or take the person's typing.
        let endsSearch: Bool
    }
    /// A row picked in the list, while `open` is the thread showing. The drawer closes whichever
    /// row it was.
    mutating func pick(_ key: InboxKey, open: InboxKey?, in layout: Layout) -> Pick {
        isOpen = false
        return Pick(opens: key != open, endsSearch: layout != .beside)
    }
    /// The window or its path changed: another page in place of the open one, the open one
    /// closed (archived), or the window turning regular. The drawer closes with any of them;
    /// pages pushed over the open one change nothing, as they can't be pushed while it is out.
    mutating func follow(layout: Layout, old: [InboxRoute], new: [InboxRoute]) {
        if layout != .page || old.first != new.first { isOpen = false }
    }

    /// The dimmed page takes taps and drags while the drawer is out or a finger holds it, so a
    /// drag that brings the list all the way in still ends where it started.
    static func closerShown(_ layout: Layout, open: Bool, held: CGFloat?) -> Bool {
        layout == .page && (open || held != nil)
    }

    /// Whether the list carries Threads, Pull requests and New thread itself. Beside a thread
    /// and as a drawer over one the tab bar is gone; filling the window, the list has it back.
    static func listHoldsTabs(_ layout: Layout) -> Bool { layout != .list }

    /// An edge swipe opens the list only at the open page's root: over a pushed page (a child
    /// thread, a file, the browser) the same swipe is the system's Back.
    static func edgeOpens(_ layout: Layout, path: [InboxRoute]) -> Bool {
        layout == .page && path.count == 1
    }

    /// The list's width over a page: about four fifths of the window, so the page stays in
    /// sight at the trailing edge, and never wider than the list beside a thread.
    static func listWidth(window: CGFloat) -> CGFloat {
        min((window * 0.8).rounded(), ThreadColumns.listWidth.max)
    }

    /// How far open (0 closed, 1 open) a horizontal drag of `translation` leaves the list, from
    /// where it started.
    static func progress(from open: Bool, translation: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return open ? 1 : 0 }
        return min(max((open ? 1 : 0) + translation / width, 0), 1)
    }

    /// A flick faster than this, in points per second, settles the way it moves.
    static let flick: CGFloat = 400
    /// Where a released drag settles: a flick follows its direction, otherwise the nearer end.
    static func settlesOpen(progress: CGFloat, velocity: CGFloat) -> Bool {
        if abs(velocity) >= flick { return velocity > 0 }
        return progress >= 0.5
    }

    /// Where the list and the page sit for a layout and how far the list is out.
    struct Placement: Equatable {
        /// The list's width and its offset from the window's leading edge.
        var listWidth: CGFloat
        var listOffset: CGFloat
        var listOpacity: Double
        /// The page's offset from the leading edge, and how dimmed it is (0 to 1).
        var pageOffset: CGFloat
        var dim: Double
        /// The page takes the display's rounded corners while it is out of its place or dimmed.
        var rounded: Bool { pageOffset != 0 || dim > 0 }
    }

    /// The list slides in from the leading edge as the page slides aside, one strip. Reduce
    /// Motion keeps both in place: the list fades in over the dimmed page. With nothing open the
    /// list fills the window and the empty page waits off its trailing edge, so the first thread
    /// opened slides in over where the list was.
    static func placement(_ layout: Layout, progress: CGFloat, window: CGFloat, reduceMotion: Bool) -> Placement {
        switch layout {
        case .beside:
            return Placement(listWidth: 0, listOffset: 0, listOpacity: 0, pageOffset: 0, dim: 0)
        case .list:
            return Placement(listWidth: window, listOffset: 0, listOpacity: 1, pageOffset: reduceMotion ? 0 : window, dim: 0)
        case .page:
            let width = listWidth(window: window), shown = min(max(progress, 0), 1)
            if reduceMotion {
                return Placement(listWidth: width, listOffset: 0, listOpacity: shown, pageOffset: 0, dim: shown)
            }
            return Placement(listWidth: width, listOffset: (shown - 1) * width, listOpacity: 1, pageOffset: shown * width, dim: shown)
        }
    }
}

/// The drawer's place while a finger holds it. Only the modifiers that place the list and the
/// page read it, so a drag redraws their offsets and nothing of the thread or the list.
@MainActor @Observable final class DrawerHold {
    /// How far open (0 closed, 1 open) while a finger holds the drawer; nil when none does.
    private(set) var progress: CGFloat?
    /// The layout the list and page are placed for, which follows the window's with animation.
    var layout = ThreadDrawer.Layout.list
    @ObservationIgnored private var from = false

    /// A finger took the drawer, open or closed.
    func begin(from open: Bool) {
        from = open
        progress = open ? 1 : 0
    }
    /// The finger moved `translation` sideways from where it took the drawer, `width` wide.
    func move(_ translation: CGFloat, width: CGFloat) {
        progress = ThreadDrawer.progress(from: from, translation: translation, width: width)
    }
    /// The finger let go, or the system cancelled its drag (velocity zero): whether the drawer
    /// settles open, nil when no finger held it.
    func release(velocity: CGFloat) -> Bool? {
        guard let progress else { return nil }
        self.progress = nil
        return ThreadDrawer.settlesOpen(progress: progress, velocity: velocity)
    }
    /// The drawer was opened or closed some other way while a finger held it.
    func drop() { progress = nil }
}
