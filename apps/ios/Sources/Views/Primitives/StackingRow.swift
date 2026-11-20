import SwiftUI

/// A row's words and its control: side by side, and at accessibility text sizes the control goes
/// under the words (design language: rows stack at large text), so neither squeezes the other.
struct StackingRow<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.dynamicTypeSize) private var typeSize
    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }
    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.tight))
            : AnyLayout(HStackLayout(spacing: AceDesign.Space.related))
        layout { content() }
    }
}
