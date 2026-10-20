import AVFoundation
import SwiftUI
import UIKit

/// The live page: decoded video on a sample-buffer display layer, fingers forwarded as the page's
/// touch points, and the hidden field that brings up the keyboard for the page's focused field.
/// While it is on screen a display link draws the newest decoded picture once per refresh, up to
/// 60 times a second; the layer keeps the last one until a newer arrives.
final class BrowserSurfaceView: UIView {
    private let videoLayer = AVSampleBufferDisplayLayer()
    private var samples = DisplaySamples()
    private var link: CADisplayLink?
    let textField = RemoteTextField()
    /// The drawn picture's page size in CSS pixels; zero before the first.
    private(set) var pageSize: CGSize = .zero
    /// The newest picture decoded since the last refresh, if any.
    var nextPicture: () -> BrowserPicture? = { nil }
    var interactive = true
    var onInput: ([RemoteInput]) -> Void = { _ in } {
        didSet { textField.onInput = onInput }
    }
    /// The view settled at a new size or scale.
    var onLayout: (CGSize, CGFloat) -> Void = { _, _ in }
    /// A finger touched the page (the keyboard opens for a field the person just tapped).
    var onTouch: () -> Void = {}
    private var tracker = TouchTracker<ObjectIdentifier>()
    private var reported: (size: CGSize, scale: CGFloat)?
    private var settle: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(AceTheme.Colours.secondaryBackground)
        isMultipleTouchEnabled = true
        videoLayer.videoGravity = .resizeAspect
        layer.addSublayer(videoLayer)
        addSubview(textField)
        isAccessibilityElement = true
        accessibilityLabel = "Live browser page"
        accessibilityTraits = .allowsDirectInteraction
        accessibilityIdentifier = "browser.surface"
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoLayer.frame = bounds
        CATransaction.commit()
        report()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        let link = CADisplayLink(target: DisplayTick(self), selector: #selector(DisplayTick.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
    }
    /// Places the hidden field over the page's focused field, so the system's text UI (the IME's
    /// candidates, dictation) appears next to it.
    func place(field rect: PageRect?) {
        guard let rect else { textField.frame = CGRect(x: 0, y: 0, width: 1, height: 1); return }
        let shown = PageGeometry(view: bounds.size, page: pageSize).viewRect(rect)
        textField.frame = CGRect(x: shown.minX, y: shown.minY, width: max(1, shown.width), height: max(1, shown.height))
    }

    /// One screen refresh: draws the newest picture, if one arrived since the last.
    fileprivate func drawNewest() {
        guard let picture = nextPicture(), let sample = samples.sample(picture.image) else { return }
        let renderer = videoLayer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
        pageSize = picture.page
    }

    /// Sends the size once now, then again only once a change settles (rotation, split view).
    private func report() {
        let size = bounds.size, scale = traitCollection.displayScale
        guard size.width > 0, size.height > 0 else { return }
        if let reported, reported.size == size, reported.scale == scale { return }
        settle?.cancel()
        let send = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reported = (size, scale)
            self.onLayout(size, scale)
        }
        settle = send
        if reported == nil { send.perform() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: send) }
    }

    private func points(_ touches: Set<UITouch>) -> [(ObjectIdentifier, CGPoint)] {
        let geometry = PageGeometry(view: bounds.size, page: pageSize)
        return touches.map { (ObjectIdentifier($0), geometry.pagePoint($0.location(in: self))) }
    }
    private var accepting: Bool { interactive && pageSize.width > 0 && pageSize.height > 0 }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard accepting else { return }
        onTouch()
        if let input = tracker.began(points(touches)) { onInput([input]) }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard accepting, let input = tracker.moved(points(touches)) else { return }
        onInput([input])
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let input = tracker.ended(touches.map { ObjectIdentifier($0) }) { onInput([input]) }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let input = tracker.cancelled() { onInput([input]) }
    }
}

/// The display link's target: the link holds it strongly, so it holds the surface weakly.
@MainActor private final class DisplayTick: NSObject {
    private weak var surface: BrowserSurfaceView?
    init(_ surface: BrowserSurfaceView) { self.surface = surface }
    @objc func tick(_ link: CADisplayLink) { surface?.drawNewest() }
}

/// SwiftUI's handle on the surface: opens the view at its first size, follows the page's focused
/// field with the keyboard, and hands the surface to the model to draw on.
struct BrowserSurface: UIViewRepresentable {
    @Bindable var model: ClientModel
    /// Bumped by the Keyboard button: show the keyboard for the focused field.
    let keyboardRequest: Int

    final class Coordinator {
        var lastTouch = Date.distantPast
        var focusType: String?
        var focusRect: PageRect?
        var restartedAt = Date.distantPast
        var keyboardRequest = 0
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BrowserSurfaceView {
        let view = BrowserSurfaceView()
        let model = model
        view.nextPicture = { [weak browser = model.browser] in browser?.nextPicture() }
        view.onInput = { model.browserInput($0) }
        view.onLayout = { size, scale in
            if model.browser.threadId == nil { model.openBrowser(size: size, scale: scale) }
            else { model.browserViewport(size: size, scale: scale) }
        }
        let coordinator = context.coordinator
        view.onTouch = { coordinator.lastTouch = Date() }
        coordinator.keyboardRequest = keyboardRequest
        return view
    }
    func updateUIView(_ view: BrowserSurfaceView, context: Context) {
        let coordinator = context.coordinator
        view.interactive = model.canOperate
        _ = model.browser.pageSize // Redraw the field's place when the page's size changes.
        let focus = model.canOperate ? model.browser.page?.focus : nil
        view.place(field: focus?.rect)
        guard let focus else {
            coordinator.focusType = nil
            coordinator.focusRect = nil
            if view.textField.isFirstResponder { view.textField.resignFirstResponder() }
            return
        }
        // Another field: a new kind, or one somewhere else after the person touched the page
        // (a field that only scrolled keeps what was typed, and any composition under way).
        let moved = coordinator.focusRect != focus.rect && coordinator.lastTouch > coordinator.restartedAt
        coordinator.focusRect = focus.rect
        if coordinator.focusType != focus.type || moved {
            // Start typing afresh, with the keyboard that field wants.
            let tappedJustNow = Date().timeIntervalSince(coordinator.lastTouch) < 1.5
            coordinator.focusType = focus.type
            coordinator.restartedAt = Date()
            view.textField.restart()
            view.textField.configure(KeyboardStyle(focus))
            if tappedJustNow { view.textField.becomeFirstResponder() }
        }
        if coordinator.keyboardRequest != keyboardRequest {
            coordinator.keyboardRequest = keyboardRequest
            view.textField.becomeFirstResponder()
        }
    }
    static func dismantleUIView(_ view: BrowserSurfaceView, coordinator: Coordinator) {
        view.textField.resignFirstResponder()
    }
}
