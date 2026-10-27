import SwiftUI

/// How the person reads diffs, kept on this phone: wrapped lines or one long line each, and
/// side by side where the screen is wide enough (landscape, iPad).
struct ForgeCodeOptions {
    @AppStorage("forge.code.wrap") var wrap = true
    @AppStorage("forge.code.split") var split = false
}

/// The row under a file's name: Wrap, Side by side (only where it fits), Rendered or Source for
/// a Markdown file, and the file's Viewed mark. Each is a word in a capsule; the chosen ones are
/// filled. A view-only phone shows the mark without the button.
struct ForgeCodeToolbar: View {
    @Binding var wrap: Bool
    @Binding var split: Bool
    /// Nil where the file has no rendered form.
    let rendered: Binding<Bool>?
    let wide: Bool
    /// The file's mark (`viewed`, `changed`, `unviewed`); nil where the range has none.
    let viewed: String?
    let canMark: Bool
    let marking: Bool
    let mark: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceTheme.Spacing.sm) {
                if let rendered {
                    toggle("Rendered", on: rendered.wrappedValue, identifier: "forge.code.rendered") { rendered.wrappedValue.toggle() }
                }
                if rendered?.wrappedValue != true {
                    toggle("Wrap", on: wrap, identifier: "forge.code.wrap") { wrap.toggle() }
                    if wide { toggle("Side by side", on: split, identifier: "forge.code.split") { split.toggle() } }
                }
                if let viewed { viewedControl(viewed) }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
        }
        .scrollClipDisabled()
        .sensoryFeedback(.selection, trigger: [wrap, split, rendered?.wrappedValue ?? false])
    }

    @ViewBuilder private func viewedControl(_ mark: String) -> some View {
        let checked = mark == "viewed"
        if canMark {
            toggle(checked ? "Viewed" : mark == "changed" ? "Changed since viewed · Mark viewed" : "Mark viewed",
                   on: checked, identifier: "forge.code.viewed", action: self.mark)
                .disabled(marking)
                .accessibilityValue(checked ? "Viewed" : "Not viewed")
        } else if let word = ForgeViewedWord.of(mark) {
            Text(word).meta().accessibilityIdentifier("forge.code.viewed")
        }
    }

    private func toggle(_ title: String, on: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .fontWeight(on ? .semibold : .regular)
                .foregroundStyle(on ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .padding(.horizontal, AceTheme.Spacing.md)
                .frame(minHeight: 32)
                .background(on ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
                .overlay(AceShape.capsule.strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .animation(.smooth, value: on)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}
