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
