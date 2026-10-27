import SwiftUI

/// Set on a screen shown as a tab of the iPad's side panel. Screens that are sheets elsewhere
/// drop their own close button and Esc there: the tab strip closes the tab, and the thread's
/// panel button hides the panel.
struct PanelHost {
    /// Hides the panel, as a sheet's own close would leave the thread.
    let hide: () -> Void
}

extension EnvironmentValues {
    @Entry var panelHost: PanelHost?
}

extension View {
    /// Esc closes this screen when it is a sheet; in the side panel the key is left to the thread.
    func sheetEscape(_ close: @escaping () -> Void) -> some View {
        modifier(SheetEscape(close: close))
    }
}

private struct SheetEscape: ViewModifier {
    let close: () -> Void
    @Environment(\.panelHost) private var panelHost
    func body(content: Content) -> some View {
        if panelHost == nil { content.escapeCloses(close) } else { content }
    }
}

extension View {
    /// A screen's own actions (and, optionally, what its bar shows in the middle), in the
    /// screen's own bar: a sheet's on iPhone, the panel column's own bar on iPad (the panel is
    /// the split view's inspector, apart from the thread's stack), so nothing of a panel screen
    /// reaches the thread's bar.
    func screenBar<Principal: View, Actions: View>(@ViewBuilder principal: () -> Principal,
                                                   @ViewBuilder actions: () -> Actions) -> some View {
        modifier(ScreenBar(principal: principal(), actions: actions()))
    }
    func screenBar<Actions: View>(@ViewBuilder actions: () -> Actions) -> some View {
        modifier(ScreenBar(principal: EmptyView(), actions: actions()))
    }
}

private struct ScreenBar<Principal: View, Actions: View>: ViewModifier {
    let principal: Principal
    let actions: Actions

    func body(content: Content) -> some View {
        content.toolbar {
            if Principal.self != EmptyView.self { ToolbarItem(placement: .principal) { principal } }
            ToolbarItemGroup(placement: .topBarTrailing) { actions }
        }
    }
}

/// A screen's title and subtitle in the bar, as a sheet or a pushed page. In the iPad side
/// panel the window's bar belongs to the thread, and the tab strip names the screen.
struct PageTitle: ViewModifier {
    let title: String
    let subtitle: String
    @Environment(\.panelHost) private var panelHost
    func body(content: Content) -> some View {
        if panelHost == nil { content.threadTitle(title, subtitle: subtitle) } else { content }
    }
}
