import SwiftUI
import UIKit

/// Native editable text with Dynamic Type and bounded composer height (`ComposerFit`). It reports
/// when the text no longer fits one line of the compact composer, so the composer can grow into a
/// card, and when it takes or gives up the keyboard, with the keyboard's animation duration, so
/// the composer opens to its writing height in step with the keyboard.
struct NativeTextInput: UIViewRepresentable {
    @Binding var text: String
    let inputBegan: () -> Void
    var submit: (() -> Void)? = nil
    /// The text needs more than one line of the compact composer (last reported by `onWrap`).
    var wraps = false
    var onWrap: ((Bool) -> Void)? = nil
    /// The composer shows the text as a card right now (focused or wrapped).
    var card = false
    /// Whether the text has the keyboard; it opens to the writing height.
    var focused = false
    /// The text took (true) or gave up the keyboard, with the keyboard's animation duration.
    var onFocus: ((Bool, Double) -> Void)? = nil
    var identifier = "composer.input"
    /// Takes the keyboard as soon as it shows (New thread's first message).
    var focusOnAppear = false
    /// The words and the caret's UTF-16 offset, as typing or tapping moves them (no selection,
    /// nothing being composed): the composer's `@` and `/` lists follow it.
    var onCaret: ((String, Int) -> Void)? = nil
    /// Where the caret goes after the composer changed the words itself; each value applies once.
    var place: CaretPlacement? = nil
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    @Environment(\.escape) private var escape
    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.inputBegan = inputBegan
        view.laidOut = { [weak coordinator = context.coordinator] view in coordinator?.laidOut(view) }
        context.coordinator.observeKeyboard()
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
        if let place, place.id != context.coordinator.placed {
            context.coordinator.placed = place.id
            view.selectedRange = NSRange(location: min(place.offset, (view.text as NSString).length), length: 0)
            context.coordinator.reportCaret(view)
        }
        view.inputBegan = inputBegan
        view.escape = escape
        view.compact = !card
        view.font = AceTheme.uiFont(AceTheme.Typography.body, relativeTo: .body, traits: view.traitCollection)
        view.textColor = UIColor(AceTheme.Colours.foreground)
        view.typingAttributes = AceTheme.inputAttributes(traits: view.traitCollection)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let line = UIFontMetrics(forTextStyle: .body).scaledValue(for: AceTheme.Typography.body.lineHeight, compatibleWith: uiView.traitCollection)
        let content = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let fit = ComposerFit(line: line, inset: AceTheme.Spacing.md * 2, minimum: AceTheme.Dimensions.touchTarget,
                              largeType: uiView.traitCollection.preferredContentSizeCategory.isAccessibilityCategory)
        return CGSize(width: width, height: fit.height(content: content, focused: focused))
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTextInput
        init(parent: NativeTextInput) { self.parent = parent }
        /// The last caret placement applied.
        var placed: UUID?
        func reportCaret(_ textView: UITextView) {
            guard let onCaret = parent.onCaret, textView.markedTextRange == nil, textView.selectedRange.length == 0 else { return }
            let text = textView.text ?? ""
            let caret = textView.selectedRange.location
            Task { @MainActor in onCaret(text, caret) }
        }
        /// The keyboard's last animation duration; the composer grows on the same curve.
        private var keyboardDuration = 0.35
        private var observing = false
        func observeKeyboard() {
            guard !observing else { return }
            observing = true
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillMove(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        }
        @objc private func keyboardWillMove(_ note: Notification) {
            if let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double, duration > 0 { keyboardDuration = duration }
        }
        func textViewDidBeginEditing(_ textView: UITextView) { focus(true) }
        func textViewDidEndEditing(_ textView: UITextView) { focus(false) }
        /// The keyboard's frame change is posted after editing begins or ends; waiting a turn
        /// lets its duration arrive, so the composer and the keyboard move together.
        private func focus(_ focused: Bool) {
            guard let onFocus = parent.onFocus else { return }
            Task { @MainActor [weak self] in
                guard let self, self.parent.focused != focused else { return }
                onFocus(focused, self.keyboardDuration)
            }
        }
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
            reportCaret(textView)
        }
        /// The width the text had on one line of the compact composer; the card switches back
        /// only once the text fits it again, so the layout never flips back and forth.
        private var compactWidth: CGFloat = 0
        /// Laid out in the compact composer at a new width: text restored from a draft, or
        /// typed while the composer was a card, is measured against it.
        func laidOut(_ view: ComposerTextView) {
            guard view.compact, view.bounds.width > 0, view.bounds.width != compactWidth else { return }
            compactWidth = view.bounds.width
            measure(view)
        }
        func measure(_ textView: UITextView) {
            guard let onWrap = parent.onWrap else { return }
            if !parent.card, textView.bounds.width > 0 { compactWidth = textView.bounds.width }
            let text = textView.text ?? ""
            let font = textView.font ?? UIFont.preferredFont(forTextStyle: .body)
            let needed = (text as NSString).size(withAttributes: [.font: font]).width
            let wraps = text.contains("\n") || (compactWidth > 0 && needed > compactWidth - AceTheme.Spacing.xs)
            if wraps != parent.wraps { Task { @MainActor in onWrap(wraps) } }
        }
        func textViewDidChangeSelection(_ textView: UITextView) {
            textView.scrollRangeToVisible(textView.selectedRange)
            reportCaret(textView)
        }
    }
}
/// A caret position the composer asks for once, after changing the words itself.
struct CaretPlacement: Equatable {
    let id = UUID()
    let offset: Int
}

@MainActor final class ComposerTextView: UITextView {
    var inputBegan: () -> Void = {}
    /// Esc from a hardware keyboard; without one, Esc drops the keyboard.
    var escape: (() -> Void)?
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard markedTextRange == nil, presses.contains(where: { $0.key?.keyCode == .keyboardEscape && $0.key?.modifierFlags.isEmpty == true }) else {
            return super.pressesBegan(presses, with: event)
        }
        if let escape { escape() } else { resignFirstResponder() }
    }
    /// Laid out in the one-line composer rather than the card.
    var compact = true
    var laidOut: (ComposerTextView) -> Void = { _ in }
    override func layoutSubviews() {
        super.layoutSubviews()
        laidOut(self)
    }
}
