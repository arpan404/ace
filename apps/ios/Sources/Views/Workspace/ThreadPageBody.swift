import SwiftUI

/// The thread's Changes page, as a phone shows it beside Chat: the same screen the iPad's side
/// panel holds, without a close of its own (Chat's bar button and a swipe leave it). The composer
/// stays on both pages, in the bottom safe area, so the page ends above it.
struct ThreadPageBody: View {
    @Bindable var model: ClientModel
    let title: String
    /// The file Changes opens at, when one was named.
    var changesFile: String? = nil
    /// The scope Changes shows, when one was asked for, and forgetting it once shown.
    var changesScope: String? = nil
    var scopeShown: (() -> Void)? = nil
    let openChat: () -> Void

    var body: some View {
        ChangesSheet(model: model, title: title, initial: changesFile, scope: changesScope, scopeShown: scopeShown).id(changesFile)
            // A screen that is a sheet elsewhere drops its own stack and close here (`threadPage`,
            // declared beside ChangesSheet); its Esc goes to Chat.
            .environment(\.panelHost, PanelHost(hide: openChat))
            .environment(\.threadPage, true)
            // A container, so the page is findable without its name replacing every control's.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("thread.page.changes.body")
    }
}
