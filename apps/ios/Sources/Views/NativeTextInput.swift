import SwiftUI
import UIKit

/// Native editable text with Dynamic Type and bounded composer height.
struct NativeTextInput: UIViewRepresentable {
    @Binding var text: String
    let inputBegan: () -> Void
    var submit: (() -> Void)? = nil
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.inputBegan = inputBegan
        view.font = AceTheme.uiFont(AceTheme.Typography.body, relativeTo: .body, traits: view.traitCollection)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: AceTheme.Spacing.md, left: AceTheme.Spacing.none, bottom: AceTheme.Spacing.md, right: AceTheme.Spacing.none)
        view.textContainer.lineFragmentPadding = AceTheme.Spacing.none
        view.isScrollEnabled = true
        view.accessibilityIdentifier = "composer.input"
        view.accessibilityLabel = "Steer or follow up"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.inputBegan = inputBegan
        view.font = AceTheme.uiFont(AceTheme.Typography.body, relativeTo: .body, traits: view.traitCollection)
        view.textColor = UIColor(AceTheme.Colours.foreground)
        view.typingAttributes = AceTheme.inputAttributes(traits: view.traitCollection)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let line = UIFontMetrics(forTextStyle: .body).scaledValue(for: AceTheme.Typography.body.lineHeight, compatibleWith: uiView.traitCollection)
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: max(AceTheme.Dimensions.touchTarget, min(height, line * 5 + AceTheme.Spacing.md * 2)))
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTextInput
        init(parent: NativeTextInput) { self.parent = parent }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            parent.inputBegan()
            if text == "\n", parent.returnSends, textView.markedTextRange == nil, let submit = parent.submit { submit(); return false }
            return true
        }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
            textView.scrollRangeToVisible(textView.selectedRange)
        }
        func textViewDidChangeSelection(_ textView: UITextView) { textView.scrollRangeToVisible(textView.selectedRange) }
    }
}
@MainActor final class ComposerTextView: UITextView {
    var inputBegan: () -> Void = {}
}
