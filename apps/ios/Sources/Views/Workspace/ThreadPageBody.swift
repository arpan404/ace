import SwiftUI

/// The thread's Changes page, as a phone shows it beside Chat: the same screen the iPad's side
/// panel holds, without a close of its own (Chat's bar button and a swipe leave it). It clears
/// the composer at the bottom, which stays on both pages.
struct ThreadPageBody: View {
    @Bindable var model: ClientModel
    let title: String
    /// The file Changes opens at, when one was named.
    var changesFile: String? = nil
    /// The composer block's height: the page's content ends above it.
    let barHeight: CGFloat
    let openChat: () -> Void

    var body: some View {
        ChangesSheet(model: model, title: title, initial: changesFile).id(changesFile)
            // A screen that is a sheet elsewhere drops its own stack and close here (`threadPage`,
            // declared beside ChangesSheet); its Esc goes to Chat.
            .environment(\.panelHost, PanelHost(hide: openChat))
            .environment(\.threadPage, true)
            .safeAreaPadding(.bottom, barHeight)
            .accessibilityIdentifier("thread.page.changes.body")
    }
}
