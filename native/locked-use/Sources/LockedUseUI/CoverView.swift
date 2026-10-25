import AppKit

/// Opaque, monochrome status content. It is presentation only and never implies that a
/// normal window supplies authentication, input suppression or an independent relock guard.
@MainActor final class LockedUseCoverView: NSView {
    private let title = NSTextField(labelWithString: "ace is preparing")
    private let detail = NSTextField(wrappingLabelWithString: "Preparing a protected desktop for computer use.")

    override var isOpaque: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        title.font = .systemFont(ofSize: 28, weight: .medium)
        title.textColor = .labelColor
        title.alignment = .center
        detail.font = .systemFont(ofSize: 14)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        let stack = NSStackView(views: [title, detail])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let preferredWidth = stack.widthAnchor.constraint(equalToConstant: 480)
        preferredWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            preferredWidth,
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("ace computer use status")
    }

    required init?(coder: NSCoder) { nil }

    func showWorking() {
        title.stringValue = "ace is working"
        detail.stringValue = "Use your keyboard or pointer to pause and return to the Mac lock screen."
    }

    func showRelocking() {
        title.stringValue = "ace is locking the Mac"
        detail.stringValue = "Waiting for macOS to confirm the lock."
    }

    func showPreview() {
        title.stringValue = "ace is working"
        detail.stringValue = "Preview only. This screen does not lock or unlock your Mac."
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}
