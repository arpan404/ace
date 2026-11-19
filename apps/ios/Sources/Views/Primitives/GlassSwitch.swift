import SwiftUI

/// ace's one segmented control (design language §5, the approved mockup): the choices share one
/// capsule track on the quiet fill, hugging them, and the chosen one sits raised on it with a
/// tiny shadow, sliding between them. 28pt tabs on a 3pt inset, taking taps over 44, no glass:
/// it sits on sheets and pages, not over content.
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
    @Environment(\.colorScheme) private var scheme
    @Namespace private var thumb
    /// The choices whose words are cut short on screen (`SegmentWords`).
    @State private var cut: Set<Value> = []
    /// The control's height, grown with its words' text style so large text never clips.
    @ScaledMetric(relativeTo: .subheadline) private var height = AceDesign.Size.segment

    var body: some View {
        HStack(spacing: AceDesign.Size.segmentInset - 1) {
            ForEach(choices, id: \.value) { choice in segment(choice) }
        }
        // Only the thumb slides; what the control switches changes at once.
        .animation(.default, value: selection)
        .padding(AceDesign.Size.segmentInset)
        .frame(height: height)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
        .opacity(disabled ? AceTheme.Opacity.disabled(scheme) : 1)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: selection)
    }

    private func segment(_ choice: Choice) -> some View {
        let chosen = selection == choice.value
        return Button {
            guard !chosen, !disabled else { return }
            select(choice.value)
        } label: {
            SegmentWords(title: choice.title, short: choice.short) { isCut in
                guard cut.contains(choice.value) != isCut else { return }
                if isCut { cut.insert(choice.value) } else { cut.remove(choice.value) }
            }
            .aceFont(AceDesign.TextRole.segment)
            .fontWeight(chosen ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(chosen ? AceDesign.Ink.primary : AceDesign.Ink.muted)
            .lineLimit(1)
            .padding(.horizontal, AceDesign.Space.chipTab)
            .frame(maxHeight: .infinity)
            .background {
                if chosen {
                    AceDesign.Shape.control.fill(AceDesign.Surface.raised)
                        .shadow(color: .black.opacity(AceShadow.tabOpacity), radius: AceShadow.tabRadius, y: AceShadow.tabY)
                        .matchedGeometryEffect(id: "chosen", in: thumb)
                }
            }
            .tapBand(drawn: height)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier(choice.identifier)
        #if DEBUG
        // For UI tests, which can't see an ellipsis: "cut" while the words on show are cut short.
        .accessibilityValue(cut.contains(choice.value) ? "cut" : "whole")
        #endif
    }
}

/// A segment's words: its title, else its short form, whichever fits whole, else the short form
/// cut short. Says whether the words on show are cut, by their width against their whole width.
private struct SegmentWords: View {
    let title: String
    let short: String?
    let report: (Bool) -> Void
    @State private var shown: CGFloat = 0
    @State private var whole: CGFloat = 0

    var body: some View {
        ViewThatFits(in: .horizontal) {
            Text(title)
            if let short { Text(short) }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width in
            shown = width
            reportCut()
        }
        .background {
            Text(short ?? title).fixedSize().hidden().accessibilityHidden(true)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width in
                    whole = width
                    reportCut()
                }
        }
    }

    private func reportCut() {
        guard shown > 0, whole > 0 else { return }
        report(shown + 0.5 < whole)
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
