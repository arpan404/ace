import SwiftUI

/// Which cut-off passages a person opened on one screen (`ExpandableText`), by the row's id.
/// It lives in a `Disclosures`: in a transcript the thread's own, so an opened passage counts as
/// an opened fold and the feed holds the reader's place; elsewhere one the screen keeps while it
/// is open (`remembersExpansion()`), so a row scrolled away and back stays as it was left.
@MainActor struct TextExpansion {
    let store: Disclosures
    let id: String
    /// Its own namespace, apart from the work logs' and subagent groups' keys.
    private var key: String { "text:\(id)" }
    var isOpen: Bool { store.isOpen(key) }
    func toggle() { store.toggle(key) }

    /// What the passage offers: More while it is cut, Less while it is open, nothing when it fits.
    enum Affordance: Equatable { case more, less }
    static func affordance(open: Bool, clipped: Bool) -> Affordance? {
        open ? .less : clipped ? .more : nil
    }
}

/// One row's fold (a passage, a Details), kept in the screen's `expansions` by `id`, or in the
/// row's own state where nothing on the screen remembers. A view holds it as a stored property.
struct RowFold: DynamicProperty {
    let id: String
    @Environment(\.expansions) private var store
    @State private var local = false
    init(_ id: String) { self.id = id }
    @MainActor var isOpen: Bool { store.map { TextExpansion(store: $0, id: id).isOpen } ?? local }
    @MainActor func toggle() {
        if let store { TextExpansion(store: store, id: id).toggle() } else { local.toggle() }
    }
}

extension EnvironmentValues {
    /// Where `ExpandableText` keeps what was opened; nil keeps it in the row's own state.
    @Entry var expansions: Disclosures? = nil
}

extension View {
    /// The screen remembers which passages were opened until it closes.
    func remembersExpansion() -> some View { modifier(RemembersExpansion()) }
}

private struct RemembersExpansion: ViewModifier {
    @State private var store = Disclosures()
    func body(content: Content) -> some View { content.environment(\.expansions, store) }
}
