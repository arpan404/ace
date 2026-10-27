import AVFoundation
import AVKit
import SwiftUI

/// A staged video's first frame and length, read off the main thread. The staged copy has no
/// extension, so its MIME type tells AVFoundation what it is.
enum VideoPreview {
    struct Frame: Sendable {
        let image: UIImage?
        let seconds: Double?
    }
    static func asset(_ url: URL, mimeType: String) -> AVURLAsset {
        AVURLAsset(url: url, options: [AVURLAssetOverrideMIMETypeKey: mimeType])
    }
    nonisolated static func frame(_ url: URL, mimeType: String, pixels: CGFloat) async -> Frame {
        let asset = AVURLAsset(url: url, options: [AVURLAssetOverrideMIMETypeKey: mimeType])
        let duration = try? await asset.load(.duration)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        let image = try? await generator.image(at: .zero).image
        let seconds = duration.map(CMTimeGetSeconds).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        return Frame(image: image.map { UIImage(cgImage: $0) }, seconds: seconds)
    }
    /// "0:07", "12:30", "1:02:03".
    static func length(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let pattern: Duration.TimeFormatStyle.Pattern = total >= 3600 ? .hourMinuteSecond : .minuteSecond
        return Duration.seconds(total).formatted(.time(pattern: pattern))
    }
}

/// A video full screen on a dark ground, played by the system player fitted to the space under
/// Done; Done or VoiceOver's escape closes it.
struct VideoViewer: View {
    let title: String
    let url: URL
    let mimeType: String
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            HStack {
                MediaShareButton(item: url, title: title)
                Spacer()
                MediaDoneButton { dismiss() }
            }
            if let player { SystemPlayer(player: player, label: title) }
            else { Spacer() }
        }
        .background(Color.black.ignoresSafeArea())
        .environment(\.colorScheme, .dark)
        .accessibilityAction(.escape) { dismiss() }
        .task {
            guard player == nil else { return }
            let player = AVPlayer(playerItem: AVPlayerItem(asset: VideoPreview.asset(url, mimeType: mimeType)))
            self.player = player
            player.play()
        }
        .onDisappear { player?.pause() }
    }
}

private struct SystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    let label: String
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.videoGravity = .resizeAspect
        controller.view.backgroundColor = .black
        controller.view.accessibilityIdentifier = "media.video"
        controller.view.accessibilityLabel = label
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}
