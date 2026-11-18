import SwiftUI

/// The three ways an action looks (ADR 0184): actions are controls, never words that read as
/// labels. `.primaryAction` is the one way forward on a page, `.secondaryAction` the others
/// beside it, `.rowAction` an action that is a whole row of a list. A button with the
/// destructive role draws in the system red in all three.

/// The one way forward: Liquid Glass prominent in the action colour, a filled capsule before
/// iOS 26.
struct PrimaryActionStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let tint = configuration.role == .destructive ? AceDesign.Ink.destructive : AceDesign.Ink.action
        if #available(iOS 26, *) {
            Button(configuration).buttonStyle(.glassProminent).tint(tint)
        } else {
            Button(configuration).buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(tint)
        }
    }
}

/// An action beside the way forward: clear Liquid Glass with words in the action colour, a
/// tinted capsule before iOS 26.
struct SecondaryActionStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let tint = configuration.role == .destructive ? AceDesign.Ink.destructive : AceDesign.Ink.action
        if #available(iOS 26, *) {
            Button(configuration).buttonStyle(.glass).tint(tint)
        } else {
            Button(configuration).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(tint)
        }
    }
}

extension PrimitiveButtonStyle where Self == PrimaryActionStyle {
    static var primaryAction: PrimaryActionStyle { PrimaryActionStyle() }
}

extension PrimitiveButtonStyle where Self == SecondaryActionStyle {
    static var secondaryAction: SecondaryActionStyle { SecondaryActionStyle() }
}

/// An action that is a list row ("Check again", "Sign in again", "Revoke all other devices"):
/// its words in the action colour on the row title's role, the full row's width and height to
/// tap, and the faint caret when it opens a page.
struct RowActionStyle: ButtonStyle {
    var opensPage = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            configuration.label
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(configuration.role == .destructive ? AceDesign.Ink.destructive : AceDesign.Ink.action)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: AceDesign.Space.related)
            if opensPage { RowCaret() }
        }
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine, alignment: .leading)
        .contentShape(Rectangle())
        .opacity(enabled ? configuration.isPressed ? AceDesign.Ink.pressed : 1 : AceTheme.Opacity.disabled(scheme))
    }
}

extension ButtonStyle where Self == RowActionStyle {
    static var rowAction: RowActionStyle { RowActionStyle() }
    /// A row action that pushes a page, ending in the caret.
    static var rowActionOpening: RowActionStyle { RowActionStyle(opensPage: true) }
}
