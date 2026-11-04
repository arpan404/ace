import SwiftUI
import WidgetKit

/// Everything ace shows outside the app: the one Live Activity for the person's agents, the
/// Home Screen inbox widget, and the Lock Screen's count and top thread.
@main struct AceWidgets: WidgetBundle {
    var body: some Widget {
        AgentsActivityWidget()
        InboxWidget()
        InboxAccessoryWidget()
    }
}

/// The type roles of `AceDesign.Typeface` (design-language §3), which the extension can't link:
/// system text styles, so Dynamic Type applies, and the two weights.
enum LockType {
    static let title = Font.body
    static let body = Font.callout
    static let meta = Font.footnote
    static let caption = Font.caption2
    static let code = Font.system(.footnote, design: .monospaced)
    static let strong = Font.Weight.semibold
    /// The small widget's count: the largest number on any ace surface, still a system style.
    static let count = Font.system(.largeTitle, design: .default).weight(.semibold)
    /// A status mark beside a row title, and in the Dynamic Island.
    static let glyph: CGFloat = 14
    static let islandGlyph: CGFloat = 16
}
