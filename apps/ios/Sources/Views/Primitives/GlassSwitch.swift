import SwiftUI

/// ace's one segmented control (design language §5): the choices share one capsule track on the
/// quiet fill, and the chosen one sits on the accent's capsule, which slides between them. Drawn
/// at the system segmented control's 32pt, taking taps over 44, no glass: it sits on sheets and
/// pages, not over content.
struct CapsuleSegments<Value: Hashable>: View {
    struct Choice {
        let value: Value
        let title: String
        let identifier: String
        /// Said instead when `title` doesn't fit, as in a narrow sidebar.
        var short: String? = nil
    }
    let choices: [Choice]
    let selection: Value?
    var disabled = false
    let select: (Value) -> Void
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(choices, id: \.value) { choice in segment(choice) }
        }
        .padding(AceDesign.Size.segmentInset)
        .frame(height: AceDesign.Size.segment)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
        .opacity(disabled ? AceTheme.Opacity.disabled(scheme) : 1)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: selection)
    }

    private func segment(_ choice: Choice) -> some View {
        let chosen = selection == choice.value
        return Button {
            guard !chosen, !disabled else { return }
            withAnimation(AceDesign.Motion.arriving(reduceMotion)) { select(choice.value) }
        } label: {
            ViewThatFits(in: .horizontal) {
                Text(choice.title)
                if let short = choice.short { Text(short) }
            }
            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
            .fontWeight(chosen ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(chosen ? AceDesign.Ink.onAccent : AceDesign.Ink.muted)
            .lineLimit(1)
            .padding(.horizontal, AceDesign.Space.row)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                if chosen {
                    AceDesign.Shape.control.fill(AceDesign.Ink.accent)
                        .matchedGeometryEffect(id: "chosen", in: thumb)
                }
            }
            .tapBand(drawn: AceDesign.Size.segment)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier(choice.identifier)
    }
}

/// The segmented control over a binding: Threads / Chats / Spade in the iPad sidebar, Pull
/// requests / Issues / Inbox.
struct GlassSwitch<Value: Hashable>: View {
    typealias Choice = CapsuleSegments<Value>.Choice
    @Binding var selection: Value
    let choices: [Choice]

    var body: some View {
        CapsuleSegments(choices: choices, selection: selection) { selection = $0 }
    }
}

extension CapsuleSegments where Value == String {
    /// Exclusive string choices, each identified "<prefix>.<id>".
    init(_ items: [(id: String, label: String)], selection: String?, idPrefix: String, disabled: Bool = false,
         select: @escaping (String) -> Void) {
        self.init(choices: items.map { Choice(value: $0.id, title: $0.label, identifier: "\(idPrefix).\($0.id)") },
                  selection: selection, disabled: disabled, select: select)
    }
}
