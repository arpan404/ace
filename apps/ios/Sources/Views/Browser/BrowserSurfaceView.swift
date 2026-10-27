import AVFoundation
import SwiftUI
import UIKit

/// The live page: decoded video on a sample-buffer display layer, fingers forwarded as the page's
/// touch points, and the hidden field that brings up the keyboard for the page's focused field.
/// The picture fits the view's width (`PageGeometry`); one larger than the view (a desktop, or a
/// phone taller than the view) is zoomed and moved with two fingers, and one finger still uses
/// the page.
/// While it is on screen a display link draws the newest decoded picture once per refresh, up to
/// 60 times a second; the layer keeps the last one until a newer arrives.
final class BrowserSurfaceView: UIView, UIGestureRecognizerDelegate {
    private let videoLayer = AVSampleBufferDisplayLayer()
    private var samples = DisplaySamples()
    private var link: CADisplayLink?
    let textField = RemoteTextField()
    /// The drawn picture's page size in CSS pixels; zero before the first.
    private(set) var pageSize: CGSize = .zero
    /// The person's zoom and move of the picture; back to the fit when the page's size changes.
    private var zoom: CGFloat = 1
    private var offset: CGPoint = .zero
    var geometry: PageGeometry { PageGeometry(view: bounds.size, page: pageSize, zoom: zoom, offset: offset) }
    /// The picture was zoomed or moved (overlays drawn over the page follow it).
    var onMove: (CGFloat, CGPoint) -> Void = { _, _ in }
    private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
    private lazy var pan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        return pan
    }()
    /// The newest picture decoded since the last refresh, if any.
    var nextPicture: () -> BrowserPicture? = { nil }
    /// While the person can use the page, a swipe here goes to the page, never to ace's back swipe.
    var interactive = true { didSet { claim.isEnabled = interactive } }
    private lazy var claim = SurfaceTouchClaim.install(on: self)
    var onInput: ([RemoteInput]) -> Void = { _ in } {
        didSet { textField.onInput = onInput }
    }
    /// The view settled at a new size or scale, or the picture at a new drawn size (nil before
    /// the first picture): the stream is encoded for the picture as drawn.
    var onLayout: (CGSize, CGFloat, CGSize?) -> Void = { _, _, _ in }
    /// A finger touched the page (the keyboard opens for a field the person just tapped).
    var onTouch: () -> Void = {}
    private var tracker = TouchTracker<ObjectIdentifier>()
    /// Annotate mode: one finger clicks and drags as a mouse does, two fingers scroll the page.
    var annotating = false {
        didSet {
            guard annotating != oldValue else { return }
            stroke = AnnotateStroke()
            if let input = tracker.cancelled() { onInput([input]) }
            setNeedsLayout()
        }
    }
    private var stroke = AnnotateStroke()
    private var reported: (size: CGSize, scale: CGFloat, picture: CGSize?)?
    /// The page's focused field, kept so it follows the picture as it is zoomed and moved.
    private var field: PageRect?
    private var settle: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(AceTheme.Colours.secondaryBackground)
        isMultipleTouchEnabled = true
        videoLayer.videoGravity = .resizeAspect
        layer.addSublayer(videoLayer)
        addSubview(textField)
        claim.isEnabled = interactive
        for recognizer in [pinch, pan] as [UIGestureRecognizer] {
            recognizer.delegate = self
            recognizer.isEnabled = false
            addGestureRecognizer(recognizer)
        }
        isAccessibilityElement = true
        accessibilityLabel = "Live browser page"
        accessibilityTraits = .allowsDirectInteraction
        accessibilityIdentifier = "browser.surface"
        accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "Fit page width") { [weak self] _ in self?.zoomTo(1) ?? false },
            UIAccessibilityCustomAction(name: "Zoom in") { [weak self] _ in self?.zoomBy(1.5) ?? false },
            UIAccessibilityCustomAction(name: "Zoom out") { [weak self] _ in self?.zoomBy(1 / 1.5) ?? false },
        ]
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoLayer.frame = pageSize == .zero ? bounds : geometry.box
        CATransaction.commit()
        let movable = geometry.movable
        pinch.isEnabled = movable || pageSize.width > bounds.width
        pan.isEnabled = movable || annotating
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
        field = rect
        guard let rect else { textField.frame = CGRect(x: 0, y: 0, width: 1, height: 1); return }
        let shown = geometry.viewRect(rect)
        textField.frame = CGRect(x: shown.minX, y: shown.minY, width: max(1, shown.width), height: max(1, shown.height))
    }

    /// One screen refresh: draws the newest picture, if one arrived since the last.
    fileprivate func drawNewest() {
        guard let picture = nextPicture(), let sample = samples.sample(picture.image) else { return }
        let renderer = videoLayer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
        if pageSize != picture.page {
            // Another device or size: the picture starts at the fit again.
            pageSize = picture.page
            zoom = 1
            offset = .zero
            moved()
        }
    }

    private func moved() {
        setNeedsLayout()
        place(field: field)
        onMove(zoom, offset)
    }
    private func zoomBy(_ factor: CGFloat) -> Bool {
        guard pageSize != .zero else { return false }
        let next = geometry.zoomed(by: factor, around: CGPoint(x: bounds.midX, y: bounds.midY))
        zoom = next.zoom
        offset = next.offset
        moved()
        return true
    }
    private func zoomTo(_ value: CGFloat) -> Bool { zoomBy(value / zoom) }
    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        guard recognizer.state == .changed || recognizer.state == .ended else { return }
        let next = geometry.zoomed(by: recognizer.scale, around: recognizer.location(in: self))
        recognizer.scale = 1
        zoom = next.zoom
        offset = next.offset
        moved()
    }
    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        guard recognizer.state == .changed || recognizer.state == .ended else { return }
        if annotating, !geometry.movable {
            // The overlay never takes the wheel: two fingers scroll the page under the markers.
            let delta = recognizer.translation(in: self)
            recognizer.setTranslation(.zero, in: self)
            let scale = geometry.box.width / max(1, pageSize.width)
            let at = geometry.pagePoint(recognizer.location(in: self))
            onInput([.scroll(x: at.x, y: at.y, deltaX: -delta.x / max(scale, 0.01), deltaY: -delta.y / max(scale, 0.01))])
            return
        }
        let next = geometry.panned(by: recognizer.translation(in: self))
        recognizer.setTranslation(.zero, in: self)
        offset = next.offset
        moved()
    }
    /// Zoom and move together, as in a photo.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        (gestureRecognizer === pinch && other === pan) || (gestureRecognizer === pan && other === pinch)
    }

    /// Sends the size once now, then again only once a change settles (rotation, split view).
    private func report() {
        let size = bounds.size, scale = traitCollection.displayScale
        guard size.width > 0, size.height > 0 else { return }
        let box = geometry.box
        let picture = pageSize == .zero ? nil : CGSize(width: box.width.rounded(), height: box.height.rounded())
        if let reported, reported.size == size, reported.scale == scale, reported.picture == picture { return }
        settle?.cancel()
        let send = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reported = (size, scale, picture)
            self.onLayout(size, scale, picture)
        }
        settle = send
        if reported == nil { send.perform() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: send) }
    }

    private func points(_ touches: Set<UITouch>) -> [(ObjectIdentifier, CGPoint)] {
        let geometry = geometry
        return touches.map { (ObjectIdentifier($0), geometry.pagePoint($0.location(in: self))) }
    }
    private var accepting: Bool { interactive && pageSize.width > 0 && pageSize.height > 0 }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard accepting else { return }
        onTouch()
        if annotating {
            let fingers = event?.allTouches?.count ?? touches.count
            for touch in touches {
                send(stroke.began(view: touch.location(in: self), page: geometry.pagePoint(touch.location(in: self)), fingers: fingers))
            }
            return
        }
        if let input = tracker.began(points(touches)) { onInput([input]) }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard accepting else { return }
        if annotating {
            guard (event?.allTouches?.count ?? touches.count) == 1, let touch = touches.first else { return }
            send(stroke.moved(view: touch.location(in: self), page: geometry.pagePoint(touch.location(in: self))))
            return
        }
        guard let input = tracker.moved(points(touches)) else { return }
        onInput([input])
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if annotating {
            send(stroke.ended())
            return
        }
        if let input = tracker.ended(touches.map { ObjectIdentifier($0) }) { onInput([input]) }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        if annotating {
            send(stroke.cancelled())
            return
        }
        if let input = tracker.cancelled() { onInput([input]) }
    }
    private func send(_ inputs: [RemoteInput]) {
        guard !inputs.isEmpty else { return }
        onInput(inputs)
        // A pin or an area outlined: a light tap under the finger.
        if inputs.contains(where: { if case .mouse(let event, _, _, _) = $0 { event == "mouseReleased" } else { false } }) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
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
    /// Annotate mode is on: the page's overlay takes clicks and drags.
    var annotating = false

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
        view.onMove = { zoom, offset in model.browser.movePicture(zoom: zoom, offset: offset) }
        view.onLayout = { size, scale, picture in
            if model.browser.threadId == nil { model.openBrowser(size: size, scale: scale) }
            else { model.browserViewport(size: size, scale: scale, picture: picture) }
        }
        let coordinator = context.coordinator
        view.onTouch = { coordinator.lastTouch = Date() }
        coordinator.keyboardRequest = keyboardRequest
        return view
    }
    func updateUIView(_ view: BrowserSurfaceView, context: Context) {
        let coordinator = context.coordinator
        view.interactive = model.canOperate
        view.annotating = annotating
        _ = model.browser.pageSize // Redraw the field's place when the page's size changes.
        let focus = model.canOperate ? model.browser.page?.focus : nil
        view.place(field: focus?.rect)
        guard let focus else {
            coordinator.focusType = nil
            coordinator.focusRect = nil
            // The overlay's comment editor lives in its own shadow root, so the page reports no
            // field: in annotate mode the Keyboard button still types into it.
            if annotating, coordinator.keyboardRequest != keyboardRequest {
                coordinator.keyboardRequest = keyboardRequest
                view.textField.becomeFirstResponder()
                return
            }
            if view.textField.isFirstResponder, !annotating { view.textField.resignFirstResponder() }
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
