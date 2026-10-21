import SwiftUI

/// The first message's composer card. Follow-ups use `ComposerView`, which shares its send button.
struct ComposerSurface<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
            .padding(.vertical, AceTheme.Spacing.sm)
            .floatingGlass()
    }
}

/// The composer's round send button: ink with an arrow to send, a pale-red square to stop the
/// tree while it works, grey while there is nothing to send.
struct ComposerActionButton: View {
    var stopping = false
    var saving = false
    let disabled: Bool
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Group {
                if saving { ProgressView().tint(AceTheme.Colours.onAccent) }
                else if stopping {
                    RoundedRectangle(cornerRadius: AceTheme.Radii.badge)
                        .frame(width: AceTheme.Spacing.md, height: AceTheme.Spacing.md)
                } else {
                    Image(systemName: "arrow.up").font(.body.weight(.semibold))
                }
            }
            .frame(width: AceTheme.Spacing.xxxl + AceTheme.Spacing.xs, height: AceTheme.Spacing.xxxl + AceTheme.Spacing.xs)
            .foregroundStyle(foreground)
            .background(background, in: Circle())
            .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).accessibilityLabel(label)
    }
    private var foreground: Color {
        if stopping { return AceTheme.StatusText.failed }
        return disabled && !saving ? AceTheme.Colours.decoration : AceTheme.Colours.onAccent
    }
    private var background: Color {
        if stopping { return AceTheme.Colours.diffDelete }
        return disabled && !saving ? AceTheme.Colours.fill : AceTheme.Colours.accent
    }
}
