import SwiftUI

/// The first message's composer card. Follow-ups use `ComposerView`, which shares its send button.
struct ComposerSurface<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
            .padding(.vertical, AceTheme.Spacing.sm)
            .composerGlass(in: AceShape.field)
    }
}

/// The composer's round send button: ink with an arrow to send (or the Steer or Queue glyph while
/// the agent works), an ink square to stop the tree while it works, grey while there is nothing
/// to send.
struct ComposerActionButton: View {
    var stopping = false
    var saving = false
    let disabled: Bool
    let label: String
    var glyph: AceIcon.Name = .arrowUp
    /// The tap area's side; the round sits a little inside it.
    var size: CGFloat = AceTheme.Dimensions.touchTarget
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Group {
                if saving { ProgressView().tint(AceTheme.Colours.onAccent) }
                else if stopping {
                    AceShape.stopGlyph
                        .frame(width: AceTheme.Spacing.sm + AceTheme.Spacing.xxs, height: AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
                } else {
                    AceIcon(glyph, size: 16, weight: .bold, relativeTo: .body)
                }
            }
            .frame(width: size - AceTheme.Spacing.sm, height: size - AceTheme.Spacing.sm)
            .foregroundStyle(foreground)
            .background(background, in: Circle())
            .frame(width: size, height: size)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).accessibilityLabel(label)
    }
    /// Stop is ink like Send (red is for destructive confirmations only); a Stop already on its
    /// way and an empty message are grey.
    private var foreground: Color {
        disabled && !saving ? AceTheme.Colours.decoration : AceTheme.Colours.onAccent
    }
    private var background: Color {
        disabled && !saving ? AceTheme.Colours.fill : AceTheme.Colours.accent
    }
}
