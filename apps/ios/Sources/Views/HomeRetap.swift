import SwiftUI

/// A place's tab tapped while it shows, counted per place: its list scrolls back to the top
/// (`scrollsToTop(on:)`). Observed per place, so a tap redraws only the list it asks.
@MainActor @Observable final class HomeRetap {
    private var asks: [InboxTab: Int] = [:]
    func ask(_ place: InboxTab) { asks[place, default: 0] += 1 }
    func count(_ place: InboxTab) -> Int { asks[place] ?? 0 }
}

extension View {
    /// The list scrolls back to `first`, its first row's id, when its place's tab is tapped again
    /// (`HomeRetap`). A List is a UIKit collection that a `ScrollPosition` edge doesn't move, so
    /// a reader scrolls to the row itself.
    func scrollsToTop(on place: InboxTab, first: AnyHashable?) -> some View {
        modifier(ScrollsToTop(place: place, first: first))
    }
}

private struct ScrollsToTop: ViewModifier {
    let place: InboxTab
    let first: AnyHashable?
    @Environment(\.homeRetap) private var retap
    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: retap?.count(place)) {
                guard let first else { return }
                withAnimation { proxy.scrollTo(first, anchor: .top) }
            }
        }
    }
}

extension EnvironmentValues {
    /// The home tabs' re-taps (`HomeRetap`); nil outside the home screen.
    @Entry var homeRetap: HomeRetap? = nil
    /// The home tab showing, and (set per tab's content) the place a page belongs to: only the
    /// showing place's pages may write the shared tab bar (`TabBarPlace`).
    @Entry var homeTab: InboxTab? = nil
    @Entry var homePlace: InboxTab? = nil
    /// A Spade bot works on a machine that shows Spade: Spade's face at the sidebar's foot moves
    /// its eyes.
    @Entry var spadeWorking = false
}
