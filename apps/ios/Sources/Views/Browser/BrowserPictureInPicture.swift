import AVFoundation
import AVKit
import UIKit

/// Picture in Picture of the live page: the system floats the same sample-buffer layer the page
/// is drawn on, so the person can watch an agent work from the Home Screen or another app. A
/// live page has no timeline, so it can't be paused or skipped. While it floats, pictures keep
/// being drawn by a timer (the display link stops in the background) and keep being acknowledged.
@MainActor final class BrowserPictureInPicture: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
    private var controller: AVPictureInPictureController?
    private var timer: Timer?
    private let draw: () -> Void
    /// It started (true) or ended (false).
    var changed: (Bool) -> Void = { _ in }
    /// Offered only while the app declares the audio background mode (`project.yml`,
    /// `UIBackgroundModes`), which the system needs for it: removing that one entry removes
    /// Picture in Picture and its menu item.
    static var supported: Bool {
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        return modes.contains("audio") && AVPictureInPictureController.isPictureInPictureSupported()
    }

    init(layer: AVSampleBufferDisplayLayer, draw: @escaping () -> Void) {
        self.draw = draw
        super.init()
        guard Self.supported else { return }
        let controller = AVPictureInPictureController(contentSource: .init(sampleBufferDisplayLayer: layer, playbackDelegate: self))
        controller.delegate = self
        controller.requiresLinearPlayback = true
        self.controller = controller
    }
    var active: Bool { controller?.isPictureInPictureActive ?? false }

    func toggle() {
        guard let controller else { return }
        if controller.isPictureInPictureActive { controller.stopPictureInPicture(); return }
        // Playback, mixed with whatever else plays: the page brings no sound of its own here.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        controller.startPictureInPicture()
    }
    func stop() { controller?.stopPictureInPicture() }

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            timer?.invalidate()
            let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.draw() } }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            changed(true)
        }
    }
    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            timer?.invalidate(); timer = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            changed(false)
        }
    }
    /// The system refused to float the page (another app's Picture in Picture, a call): the
    /// audio session asked for it is let go, and the menu reads as before.
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController,
                                                failedToStartPictureInPictureWithError error: any Error) {
        MainActor.assumeIsolated {
            timer?.invalidate(); timer = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            changed(false)
        }
    }
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController,
                                                restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completion: @escaping (Bool) -> Void) {
        completion(true)
    }
    // A live page: always playing, no timeline to scrub.
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}
    nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }
    nonisolated func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { false }
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}
    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime,
                                                completion completionHandler: @escaping () -> Void) { completionHandler() }
}
