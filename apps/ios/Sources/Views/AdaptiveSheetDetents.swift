import SwiftUI

/// A sheet with half and full heights. At accessibility text sizes half a screen holds a row or
/// two, so it opens full height there; the person can still drag between both.
private struct AdaptiveSheetDetents: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var chosen: PresentationDetent?

    func body(content: Content) -> some View {
        content.presentationDetents([.medium, .large], selection: Binding(
            get: { chosen ?? (typeSize.isAccessibilitySize ? .large : .medium) },
            set: { chosen = $0 }))
    }
}

extension View {
    func adaptiveSheetDetents() -> some View { modifier(AdaptiveSheetDetents()) }
}
