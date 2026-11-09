import SwiftUI

/// A stable add-menu presenter beside the message field, in its own round surface.
struct ComposerDock<Leading: View, Content: View>: View {
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var content: () -> Content
    @Environment(\.inGlassBlock) private var inBlock
    var body: some View {
        if inBlock {
            // In the block: + leads the field's row, a plain glyph in a full tap.
            HStack(alignment: .bottom, spacing: AceTheme.Spacing.none) {
                leading()
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .tint(AceTheme.Colours.mutedForeground)
                    .buttonStyle(.plain)
                    .padding(.leading, AceDesign.Space.tight)
                    .padding(.bottom, AceDesign.Space.tight)
                content()
            }
        } else {
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
                        .frame(width: AceDesign.Size.stopGlyph, height: AceDesign.Size.stopGlyph)
                } else {
                    AceIcon(glyph, size: AceDesign.Size.sendGlyph, weight: .bold, relativeTo: .body)
                }
            }
            // A 32pt round inside its full tap.
            .frame(width: min(AceDesign.Size.send, size), height: min(AceDesign.Size.send, size))
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

/// The capsule's one trailing button, a 32pt round inside its 44pt tap, inset so its curve runs
/// parallel to the capsule's: the microphone as a bare glyph while there is nothing to send, Send
/// in the accent fill (or the Steer or Queue glyph while the agent works), Stop as the ink square,
/// and while dictating the microphone on a quiet fill.
struct ComposerTrailingButton: View {
    let state: ComposerTrailing
    var saving = false
    let disabled: Bool
    let label: String
    var sendGlyph: AceIcon.Name = .arrowUp
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Group {
                if saving { ProgressView().tint(AceTheme.Colours.onAccent) }
                else {
                    switch state {
                    case .stop:
                        AceShape.stopGlyph.frame(width: AceDesign.Size.stopGlyph, height: AceDesign.Size.stopGlyph)
                    case .send:
                        AceIcon(sendGlyph, size: AceDesign.Size.sendGlyph, weight: .bold, relativeTo: .body)
                    case .dictate, .listening:
                        AceIcon(.microphone, size: AceDesign.Size.icon, relativeTo: .body)
                    }
                }
            }
            .frame(width: AceDesign.Size.send, height: AceDesign.Size.send)
            .foregroundStyle(foreground)
            .background(background, in: Circle())
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .contentShape(Rectangle())
            .contentTransition(.opacity)
        }
        .buttonStyle(.plain).disabled(disabled).accessibilityLabel(label)
    }
    /// Send (and a send on its way) is the one accent; Stop is ink, whatever the theme's accent.
    private var foreground: Color {
        if disabled && !saving { return AceTheme.Colours.decoration }
        if saving || state == .send { return AceTheme.Colours.onAccent }
        switch state {
        case .stop: return AceTheme.Colours.background
        case .listening: return AceTheme.Colours.foreground
        default: return AceTheme.Colours.mutedForeground
        }
    }
    private var background: Color {
        if disabled && !saving { return AceTheme.Colours.fill }
        if saving || state == .send { return AceTheme.Colours.accent }
        switch state {
        case .stop: return AceTheme.Colours.foreground
        case .listening: return AceTheme.Colours.fill
        default: return .clear
        }
    }
}
