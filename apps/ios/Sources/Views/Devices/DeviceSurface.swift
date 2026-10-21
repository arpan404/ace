import AVFoundation
import SwiftUI

final class DeviceSurfaceView: UIView {
    private let video = AVSampleBufferDisplayLayer()
    private var samples = DisplaySamples()
    private var link: CADisplayLink?
    private var chunk: DeviceFrameChunk?
    private var started: CGPoint?
    var nextPicture: () -> NativeDevicePicture? = { nil }
    var onGesture: (CGPoint, CGPoint) -> Void = { _, _ in }
    var interactive = false
    override init(frame: CGRect) {
        super.init(frame: frame)
        video.videoGravity = .resize
        video.anchorPoint = .zero
        layer.addSublayer(video)
        backgroundColor = UIColor(AceTheme.Colours.secondaryBackground)
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
        chunk = picture.chunk
        fit()
        let renderer = video.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
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
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first else { return }
        started = viewport?.devicePoint(at: touch.location(in: self))
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer { started = nil }
        guard interactive, let started, let touch = touches.first, let end = viewport?.devicePoint(at: touch.location(in: self)) else { return }
        onGesture(started, end)
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { started = nil }
}
@MainActor private final class DeviceDisplayTick: NSObject {
    weak var view: DeviceSurfaceView?
    init(_ view: DeviceSurfaceView) { self.view = view }
    @objc func tick() { view?.drawNewest() }
}
struct DeviceSurface: UIViewRepresentable {
    let live: DeviceLiveModel
    let interactive: Bool
    let input: (CGPoint, CGPoint) -> Void
    func makeUIView(context: Context) -> DeviceSurfaceView { DeviceSurfaceView() }
    func updateUIView(_ view: DeviceSurfaceView, context: Context) {
        view.nextPicture = { live.nextPicture() }; view.interactive = interactive; view.onGesture = input
    }
}
