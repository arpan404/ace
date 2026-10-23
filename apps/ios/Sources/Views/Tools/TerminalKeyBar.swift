import SwiftUI

/// Keys a phone keyboard lacks, as one scrolling row of plain words and symbols above it.
/// Ctrl and Alt are sticky: one tap holds them for the next key, a second locks them, a third
/// lets go. A held modifier reads in the accent; a locked one is also underlined.
struct TerminalKeyBar: View {
    @Binding var modifiers: TerminalModifiers
    let send: (TerminalInput) -> Void

    private struct Key: Identifiable {
        let id: String
        let title: String
        let spoken: String
        let input: String
        /// Named keys take Ctrl and Alt; typed symbols take them as typed text does.
        let named: Bool
    }
    private static let leading: [Key] = [
        Key(id: "esc", title: "Esc", spoken: "Escape", input: "Escape", named: true),
        Key(id: "tab", title: "Tab", spoken: "Tab", input: "Tab", named: true),
    ]
    private static let trailing: [Key] = [
        Key(id: "up", title: "↑", spoken: "Up arrow", input: "ArrowUp", named: true),
        Key(id: "down", title: "↓", spoken: "Down arrow", input: "ArrowDown", named: true),
        Key(id: "left", title: "←", spoken: "Left arrow", input: "ArrowLeft", named: true),
        Key(id: "right", title: "→", spoken: "Right arrow", input: "ArrowRight", named: true),
        Key(id: "pipe", title: "|", spoken: "Vertical bar", input: "|", named: false),
        Key(id: "tilde", title: "~", spoken: "Tilde", input: "~", named: false),
        Key(id: "slash", title: "/", spoken: "Slash", input: "/", named: false),
        Key(id: "dash", title: "-", spoken: "Hyphen", input: "-", named: false),
        Key(id: "underscore", title: "_", spoken: "Underscore", input: "_", named: false),
        Key(id: "backtick", title: "`", spoken: "Backtick", input: "`", named: false),
        Key(id: "backslash", title: "\\", spoken: "Backslash", input: "\\", named: false),
        Key(id: "home", title: "Home", spoken: "Home", input: "Home", named: true),
        Key(id: "end", title: "End", spoken: "End", input: "End", named: true),
        Key(id: "pgup", title: "PgUp", spoken: "Page up", input: "PageUp", named: true),
        Key(id: "pgdn", title: "PgDn", spoken: "Page down", input: "PageDown", named: true),
    ]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: AceTheme.Spacing.none) {
                ForEach(Self.leading) { key in button(key) }
                modifier("Ctrl", spoken: "Control", state: $modifiers.ctrl, id: "ctrl")
                modifier("Alt", spoken: "Option", state: $modifiers.alt, id: "alt")
                ForEach(Self.trailing) { key in button(key) }
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Terminal keys")
    }

    private func button(_ key: Key) -> some View {
        Button {
            send(key.named ? modifiers.apply(key: key.input) : modifiers.apply(text: key.input)[0])
        } label: {
            Text(key.title).aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key.spoken)
        .accessibilityIdentifier("terminal.key.\(key.id)")
    }

    private func modifier(_ title: String, spoken: String, state: Binding<StickyModifier>, id: String) -> some View {
        let value = state.wrappedValue
        return Button { state.wrappedValue.tap() } label: {
            Text(title).aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                .fontWeight(value.isOn ? .medium : .regular)
                .underline(value == .locked)
                .foregroundStyle(value.isOn ? AceTheme.Colours.accent : AceTheme.Colours.foreground)
                .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityValue(value == .off ? "Off" : value == .once ? "On for the next key" : "Locked")
        .accessibilityAddTraits(value.isOn ? .isSelected : [])
        .accessibilityHint("Activate once to hold it for the next key, twice to lock it.")
        .accessibilityIdentifier("terminal.key.\(id)")
    }
}
