import SwiftUI

extension EnvironmentValues {
    /// Opens the thread's browser screen, where a transcript's browser steps lead; nil outside a thread.
    @Entry var openBrowser: (() -> Void)? = nil
}

/// A browser step in the transcript ("Opened shop.test/cart"): tapping it opens the thread's
/// browser on the phone.
struct BrowserStepLink<Content: View>: View {
    @Environment(\.openBrowser) private var openBrowser
    let isBrowser: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        if isBrowser, let openBrowser {
            Button(action: openBrowser) {
                HStack(spacing: AceTheme.Spacing.none) {
                    content()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .padding(.leading, AceTheme.Spacing.xs)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the browser")
            .accessibilityIdentifier("transcript.openBrowser")
        } else {
            content()
        }
    }
}
