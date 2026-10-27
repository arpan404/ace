import SwiftUI

/// The redesign's shared chrome. System glass draws every floating control on iOS 26; iOS 18
/// gets the regular material with a hairline edge. Content never sits on glass of its own.
extension View {
    /// Glass in `shape`: the system's own, untinted, so a floating control reads exactly like
    /// the bar's buttons beside it. `interactive` lets iOS 26 react to touches (buttons, capsules).
    @ViewBuilder func aceGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(.regular.interactive(interactive), in: shape)
        } else {
            self.background(.regularMaterial, in: shape)
                .overlay(shape.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        }
    }
    /// Liquid glass for the composer: the system's own, untinted, so the transcript scrolling
    /// behind it shows through as in the system's own apps.
    @available(iOS 26, *) static var composerLiquidGlass: Glass { .regular.interactive() }
    /// The composer, its strip and the first message's card: glass the transcript scrolls behind
    /// and shows through, softly blurred, like the system's own bars. iOS 18 gets the thin
    /// material with a hairline edge.
    @ViewBuilder func composerGlass<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(Self.composerLiquidGlass, in: shape)
        } else {
            self.background(.thinMaterial, in: shape)
                .overlay(shape.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        }
    }
}

extension View {
    /// The strip and the composer drawn as one glass on iOS 26, so where they meet reads as one
    /// surface rather than two blurs stacked.
    @ViewBuilder func composerGlassGroup() -> some View {
        if #available(iOS 26, *) { GlassEffectContainer(spacing: AceTheme.Spacing.none) { self } } else { self }
    }
}

/// A round glass icon button: the inbox's Settings and the floating jump-to-latest control.
struct GlassIconButton: View {
    let systemImage: String
    let label: String
    var size: CGFloat = AceTheme.Dimensions.touchTarget
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3.weight(.medium))
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Circle(), interactive: true)
        .accessibilityLabel(label)
    }
}

/// The three verbs a request offers, as full-width pills: the one action the card exists for,
/// a quiet alternative, and a pale-red refusal. Never more than one primary per surface.
struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, refuse }
    let kind: Kind
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.label, relativeTo: .body)
            .fontWeight(.semibold)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
            .background(background, in: AceShape.capsule)
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : AceTheme.Opacity.disabled(scheme))
            .contentShape(AceShape.capsule)
    }
    private var foreground: Color {
        switch kind {
        case .primary: AceTheme.Colours.onAccent
        case .secondary: AceTheme.Colours.foreground
        case .refuse: AceTheme.StatusText.failed
        }
    }
    private var background: Color {
        switch kind {
        case .primary: AceTheme.Colours.accent
        case .secondary: AceTheme.Colours.fill
        case .refuse: AceTheme.Colours.diffDelete
        }
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pillPrimary: PillButtonStyle { PillButtonStyle(kind: .primary) }
    static var pillSecondary: PillButtonStyle { PillButtonStyle(kind: .secondary) }
    static var pillRefuse: PillButtonStyle { PillButtonStyle(kind: .refuse) }
}

/// The SF Symbol that stands beside each shared status word. Colour comes from `StateStyle`;
/// the token itself is decided by the bridge, never here.
enum StatusSymbol {
    static func name(_ token: String) -> String? {
        switch token {
        case "needsYou": "exclamationmark.circle"
        case "working": "circle.dashed"
        case "waiting": "hourglass"
        case "failed": "xmark.circle"
        case "done": "checkmark.circle"
        case "unresponsive": "exclamationmark.triangle"
        default: nil
        }
    }
    /// Words that ask for the person are loud; work in progress recedes.
    static func isLoud(_ token: String) -> Bool { token == "needsYou" || token == "failed" }
}
