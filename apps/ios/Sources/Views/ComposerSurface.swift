import SwiftUI

/// A stable add-menu presenter beside the message field, in its own round surface.
struct ComposerDock<Leading: View, Content: View>: View {
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var content: () -> Content
    var body: some View {
        HStack(alignment: .bottom, spacing: AceDesign.Space.related) {
            leading()
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .foregroundStyle(AceTheme.Colours.foreground)
                .tint(AceTheme.Colours.foreground)
                .buttonStyle(.plain)
                .aceGlass(in: Circle(), interactive: true)
                .padding(.bottom, AceTheme.Spacing.xxs)
            content()
        }
    }
}

/// The first message's composer card. Follow-ups use `ComposerView`, which shares its send button.
struct ComposerSurface<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
            .padding(.vertical, AceDesign.Space.related)
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
    var size: CGFloat = AceDesign.Size.tap
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Group {
                if saving { ProgressView().tint(AceTheme.Colours.onAccent) }
                else if stopping {
                    AceShape.stopGlyph
                        .frame(width: AceDesign.Space.related + AceTheme.Spacing.xxs, height: AceDesign.Space.related + AceTheme.Spacing.xxs)
                } else {
                    AceIcon(glyph, size: AceDesign.Size.icon, relativeTo: .body)
                }
            }
            .frame(width: size - AceDesign.Space.related, height: size - AceDesign.Space.related)
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
