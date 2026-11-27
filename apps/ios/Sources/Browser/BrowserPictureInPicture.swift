import AVFAudio
import AVKit
import CoreMedia
import UIKit

/// The live page in system picture-in-picture: a sample-buffer display layer fed with the
/// renderer's decoded pictures. While the Browser shows, its surface mirrors each picture here so
/// the system can float it the moment the person leaves the app; while floating, this pulls the
/// newest picture itself. When to float is `BrowserPipRule`; this only does it.
@MainActor final class BrowserPictureInPicture: NSObject {
    /// What AVKit reported, in its order; `PipLifecycle` decides what each means.
    enum Event: Equatable {
        case willStart, didStart, failed
        /// `restore` when the person asked to go back to the page.
        case ended(restore: Bool)
    }
    var onEvent: (Event) -> Void = { _ in }
    /// The newest decoded picture, once the Browser isn't showing.
    var nextPicture: () -> BrowserPicture? = { nil }

    private let layer = AVSampleBufferDisplayLayer()
    /// The layer's place in the window, which the system needs to float it; too small to see.
    private let host = UIView(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private var controller: AVPictureInPictureController?
    private var samples = DisplaySamples()
    private var pulling: Timer?
    private var restoring = false

    override init() {
        super.init()
        host.isUserInteractionEnabled = false
        host.alpha = 0.01
        host.layer.addSublayer(layer)
        layer.frame = host.bounds
        layer.videoGravity = .resizeAspect
    }

    /// Whether leaving the app floats the page by itself (the rule holds away from the Browser).
    func arm(_ armed: Bool) {
        guard armed || controller != nil else { return }
        guard let controller = prepared() else { return }
        controller.canStartPictureInPictureAutomaticallyFromInline = armed
    }
    /// One picture the surface drew; the float shows the same.
    func mirror(_ sample: CMSampleBuffer) {
        guard controller != nil else { return }
        enqueue(sample)
    }
    /// Float the page now (the person left the Browser); false when the system can't.
    func start() -> Bool {
        guard let controller = prepared(), controller.isPictureInPicturePossible else { return false }
        controller.startPictureInPicture()
        return true
    }
    /// Ends the float, or one still starting: AVKit's late did-start is stopped by its owner.
    func stop() {
        stopPulling()
        guard let controller else { return }
        controller.canStartPictureInPictureAutomaticallyFromInline = false
        if controller.isPictureInPictureActive { controller.stopPictureInPicture() }
    }
    private func stopPulling() {
        pulling?.invalidate()
        pulling = nil
    }

    private func prepared() -> AVPictureInPictureController? {
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return nil }
        if host.window == nil, let window = Self.window() { window.insertSubview(host, at: 0) }
        if let controller { return controller }
        // Picture-in-picture needs the playback category; it doesn't make the session active.
        AppAudioSession.shared.setIdle(.pageSound)
        let made = AVPictureInPictureController(contentSource: .init(sampleBufferDisplayLayer: layer, playbackDelegate: self))
        made.delegate = self
        made.requiresLinearPlayback = true
        controller = made
        return made
    }
    private func enqueue(_ sample: CMSampleBuffer) {
        let renderer = layer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
    }
    /// A timer, not a display link: it keeps firing while the app is in the background.
    private func startPulling() {
        guard pulling == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pull() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pulling = timer
    }
    private func pull() {
        guard let picture = nextPicture(), let sample = samples.sample(picture.image) else { return }
        enqueue(sample)
    }
    private static func window() -> UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow }
    }
}

extension BrowserPictureInPicture: @preconcurrency AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        restoring = false
        // The surface's display link doesn't run once the Browser or the app is left.
        startPulling()
        onEvent(.willStart)
    }
    func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        onEvent(.didStart)
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: any Error) {
        stopPulling()
        onEvent(.failed)
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController,
                                    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        restoring = true
        completionHandler(true)
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        stopPulling()
        let restore = restoring
        restoring = false
        onEvent(.ended(restore: restore))
    }
}

/// A live page: always playing, no timeline to seek.
extension BrowserPictureInPicture: @preconcurrency AVPictureInPictureSampleBufferPlaybackDelegate {
    func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}
    func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }
    func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { false }
    func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}
    func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime,
                                    completion completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
