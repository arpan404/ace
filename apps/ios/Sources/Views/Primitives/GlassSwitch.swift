import SwiftUI

/// A two- or three-way switch on glass, drawn like the tab bar: the choices share one capsule and
/// the chosen one sits in a filled capsule that slides between them. Pulls / Issues, and the iPad
/// sidebar's Threads / Pull requests.
struct GlassSwitch<Value: Hashable>: View {
    struct Choice {
        let value: Value
        let title: String
        let identifier: String
        /// Said instead when `title` doesn't fit, as in a narrow sidebar.
        var short: String? = nil
    }
    @Binding var selection: Value
    let choices: [Choice]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var fill

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(choices, id: \.value) { choice in segment(choice) }
        }
        .padding(4)
        .aceGlass(in: AceShape.capsule, interactive: true)
    }

    private func segment(_ choice: Choice) -> some View {
        let chosen = selection == choice.value
        return Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) { selection = choice.value }
        } label: {
            ViewThatFits(in: .horizontal) {
                Text(choice.title)
                if let short = choice.short { Text(short) }
            }
                .aceFont(AceTheme.TypeStyle(size: 14, lineHeight: 19, weight: 600, tracking: 0), relativeTo: .subheadline)
                .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .padding(.horizontal, AceTheme.Spacing.md)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background {
                    if chosen {
                        AceShape.capsule.fill(AceTheme.Colours.foreground.opacity(0.14))
                            .matchedGeometryEffect(id: "chosen", in: fill)
                    }
                }
                .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier(choice.identifier)
    }
}
