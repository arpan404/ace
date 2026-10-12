import SwiftUI
import UIKit

/// Native editable text with Dynamic Type and bounded composer height.
struct NativeTextInput: UIViewRepresentable {
    @Binding var text: String
    let inputBegan: () -> Void
    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.inputBegan = inputBegan
        view.font = AceTheme.uiFont(AceTheme.Typography.body, relativeTo: .body, traits: view.traitCollection)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = AceTheme.Spacing.none
        view.isScrollEnabled = false
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
        return CGSize(width: width, height: max(line, min(height, line * 5)))
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTextInput
        init(parent: NativeTextInput) { self.parent = parent }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            parent.inputBegan()
            return true
        }
        func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
    }
}
@MainActor final class ComposerTextView: UITextView {
    var inputBegan: () -> Void = {}
}
