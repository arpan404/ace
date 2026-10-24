import AVFoundation
import CoreImage
import SwiftUI

/// A device's or Mac app's live picture, drawn as decoded at the display's pace, turned upright
/// and fitted to the view. A finger's press and release reach `onGesture` in device points.
final class DeviceSurfaceView: UIView {
    private let video = AVSampleBufferDisplayLayer()
    private var samples = DisplaySamples()
    private var link: CADisplayLink?
    private var chunk: DeviceFrameChunk?
    private var shown: CVPixelBuffer?
    private var started: DevicePress?
    var nextPicture: () -> NativeDevicePicture? = { nil }
    var onGesture: (DevicePress, DevicePress) -> Void = { _, _ in }
    /// The upright picture's size in device points, each time it changes.
    var onScreenSize: (CGSize) -> Void = { _ in }
    /// The degrees the picture turns to stand upright, each time they change.
    var onTurn: (DeviceRotation) -> Void = { _ in }
    /// While the person drives, a swipe here goes to the device, never to ace's back swipe.
    var interactive = false { didSet { claim.isEnabled = interactive } }
    private lazy var claim = SurfaceTouchClaim.install(on: self)
    override init(frame: CGRect) {
        super.init(frame: frame)
        claim.isEnabled = interactive
        video.videoGravity = .resize
        video.anchorPoint = .zero
        layer.addSublayer(video)
        backgroundColor = .black
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityLabel = "Remote device screen"
        accessibilityIdentifier = "devices.surface"
        accessibilityTraits = .allowsDirectInteraction
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate(); link = nil
        if window != nil {
            let link = CADisplayLink(target: DeviceDisplayTick(self), selector: #selector(DeviceDisplayTick.tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common); self.link = link
        }
    }
    override func layoutSubviews() { super.layoutSubviews(); fit() }
    fileprivate func drawNewest() {
        guard let picture = nextPicture(), let sample = samples.sample(picture.image) else { return }
        let size = Self.screenSize(picture.chunk)
        if chunk.map(Self.screenSize) != size { onScreenSize(size) }
        if chunk?.rotation != picture.chunk.rotation { onTurn(picture.chunk.rotation) }
        chunk = picture.chunk
        shown = picture.image
        fit()
        let renderer = video.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
    }
    /// The picture on screen now, upright, for Screenshot.
    func snapshot() -> UIImage? {
        guard let shown, let chunk else { return nil }
        let turned = CIImage(cvPixelBuffer: shown).oriented(Self.orientation(chunk.rotation))
        guard let image = CIContext().createCGImage(turned, from: turned.extent) else { return nil }
        return UIImage(cgImage: image, scale: chunk.scale, orientation: .up)
    }
    private static func screenSize(_ chunk: DeviceFrameChunk) -> CGSize {
        let width = Double(chunk.width) / chunk.scale, height = Double(chunk.height) / chunk.scale
        return chunk.rotation.swapsSides ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }
    private static func orientation(_ rotation: DeviceRotation) -> CGImagePropertyOrientation {
        switch rotation {
        case .none: .up
        case .quarter: .right
        case .half: .down
        case .threeQuarters: .left
        }
    }
    private var viewport: DeviceViewport? { chunk.map { DeviceViewport($0, viewSize: bounds.size) } }
    private func fit() {
        guard let chunk, let viewport else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        video.bounds = CGRect(x: 0, y: 0, width: chunk.width, height: chunk.height)
        video.position = .zero
        video.setAffineTransform(viewport.transform)
        CATransaction.commit()
    }
    private func press(_ touch: UITouch) -> DevicePress? {
        viewport?.devicePoint(at: touch.location(in: self)).map { DevicePress(point: $0, at: touch.timestamp * 1000) }
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first else { return }
        started = press(touch)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer { started = nil }
        guard interactive, let started, let touch = touches.first, let end = press(touch) else { return }
        onGesture(started, end)
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { started = nil }
}
@MainActor private final class DeviceDisplayTick: NSObject {
    weak var view: DeviceSurfaceView?
    init(_ view: DeviceSurfaceView) { self.view = view }
    @objc func tick() { view?.drawNewest() }
}

/// Lets a screen's toolbar ask its surface for the picture it shows.
@MainActor final class DeviceSurfaceHandle {
    fileprivate weak var view: DeviceSurfaceView?
    func snapshot() -> UIImage? { view?.snapshot() }
}

struct DeviceSurface: UIViewRepresentable {
    let next: () -> NativeDevicePicture?
    let interactive: Bool
    var handle: DeviceSurfaceHandle? = nil
    var label = "Remote device screen"
    var identifier = "devices.surface"
    var screenSize: (CGSize) -> Void = { _ in }
    var turn: (DeviceRotation) -> Void = { _ in }
    let input: (DevicePress, DevicePress) -> Void
    func makeUIView(context: Context) -> DeviceSurfaceView {
        let view = DeviceSurfaceView()
        view.accessibilityLabel = label
        view.accessibilityIdentifier = identifier
        return view
    }
    func updateUIView(_ view: DeviceSurfaceView, context: Context) {
        view.nextPicture = next; view.interactive = interactive; view.onGesture = input; view.onScreenSize = screenSize; view.onTurn = turn
        handle?.view = view
    }
}
