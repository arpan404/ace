import SwiftUI
import UIKit

/// Native editable text with Dynamic Type and bounded composer height. It reports when the text
/// no longer fits one line of the compact composer, so the composer can grow into a card.
struct NativeTextInput: UIViewRepresentable {
    @Binding var text: String
    let inputBegan: () -> Void
    var submit: (() -> Void)? = nil
    /// Whether the composer shows the text as a card (wrapped) right now.
    var wraps = false
    var onWrap: ((Bool) -> Void)? = nil
    var identifier = "composer.input"
    /// Takes the keyboard as soon as it shows (New thread's first message).
    var focusOnAppear = false
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    @Environment(\.escape) private var escape
    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.inputBegan = inputBegan
        view.resized = { [weak coordinator = context.coordinator, weak view] old, new in
            if let view { coordinator?.resized(view, from: old, to: new) }
        }
        view.font = AceTheme.uiFont(AceTheme.Typography.body, relativeTo: .body, traits: view.traitCollection)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: AceTheme.Spacing.md, left: AceTheme.Spacing.none, bottom: AceTheme.Spacing.md, right: AceTheme.Spacing.none)
        view.textContainer.lineFragmentPadding = AceTheme.Spacing.none
        view.isScrollEnabled = true
        view.accessibilityIdentifier = identifier
        if focusOnAppear { Task { @MainActor in view.becomeFirstResponder() } }
        view.accessibilityLabel = "Steer or follow up"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text; context.coordinator.measure(view) }
        view.inputBegan = inputBegan
        view.escape = escape
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
            measure(textView)
            textView.invalidateIntrinsicContentSize()
            textView.scrollRangeToVisible(textView.selectedRange)
        }
        /// The width the text had on one line of the compact composer; the card switches back
        /// only once the text fits it again, so the layout never flips back and forth.
        private var compactWidth: CGFloat = 0
        func measure(_ textView: UITextView) {
            guard let onWrap = parent.onWrap else { return }
            if !parent.wraps, textView.bounds.width > 0 { compactWidth = textView.bounds.width }
            let text = textView.text ?? ""
            let font = textView.font ?? UIFont.preferredFont(forTextStyle: .body)
            let needed = (text as NSString).size(withAttributes: [.font: font]).width
            let wraps = text.contains("\n") || (compactWidth > 0 && needed > compactWidth - AceTheme.Spacing.xs)
            if wraps != parent.wraps { Task { @MainActor in onWrap(wraps) } }
        }
        /// Whether the composer showed the card when the field last changed width.
        private var lastWraps = false
        /// The window changed width (an iPad resize, the iPhone Duo folding): the line the text
        /// must fit moved with it. A width change the card itself made is not the window's.
        func resized(_ textView: UITextView, from old: CGFloat, to new: CGFloat) {
            let wraps = parent.wraps
            defer { lastWraps = wraps }
            guard wraps == lastWraps, old > 0 else { return }
            if wraps { compactWidth += new - old }
            measure(textView)
        }
        func textViewDidChangeSelection(_ textView: UITextView) { textView.scrollRangeToVisible(textView.selectedRange) }
    }
}
@MainActor final class ComposerTextView: UITextView {
    var inputBegan: () -> Void = {}
    var resized: ((CGFloat, CGFloat) -> Void)?
    /// Esc from a hardware keyboard; without one, Esc drops the keyboard.
    var escape: (() -> Void)?
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard markedTextRange == nil, presses.contains(where: { $0.key?.keyCode == .keyboardEscape && $0.key?.modifierFlags.isEmpty == true }) else {
            return super.pressesBegan(presses, with: event)
        }
        if let escape { escape() } else { resignFirstResponder() }
    }
    private var width: CGFloat = 0
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width != width else { return }
        let old = width
        width = bounds.width
        resized?(old, width)
    }
}
