import ImageIO
import SwiftUI

/// One image full screen on a dark ground: fitted to the screen, pinch or double tap to zoom,
/// drag down or Done to close. `load` reads it (a staged file, a sent message's bytes) and
/// answers nil when it can't be read.
struct MediaViewer: View {
    let title: String
    let load: @MainActor () async -> UIImage?
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                ZoomableImage(image: image, label: title, dismiss: { dismiss() }).ignoresSafeArea()
            } else if failed {
                Text("\(title) couldn't be read.")
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(AceTheme.Spacing.xl)
            } else {
                ProgressView().accessibilityLabel("Loading \(title)")
            }
        }
        .overlay(alignment: .topTrailing) {
            Button("Done") { dismiss() }
                .aceFont(AceTheme.Typography.label, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .padding(.horizontal, AceTheme.Spacing.lg)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .floatingGlass()
                .padding(.trailing, AceTheme.Spacing.lg).padding(.top, AceTheme.Spacing.xs)
                .accessibilityIdentifier("media.close")
        }
        .environment(\.colorScheme, .dark)
        .task {
            guard image == nil else { return }
            image = await load()
            failed = image == nil
        }
    }

    /// The most pixels a viewed image keeps on its long side: sharp at 4× on a phone without
    /// holding a camera original's full bitmap.
    nonisolated static let pixels: CGFloat = 4096

    /// A file on the phone, decoded off the main thread at most `pixels` on its long side.
    static func image(at url: URL) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { downsampledImage(at: url, pixels: pixels) }.value
    }
    /// Bytes already read, decoded the same way.
    static func image(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { downsampledImage(data, pixels: pixels) }.value
    }
}

/// The file at `url` as an image no larger than `pixels` on its long side; only the downsampled
/// bitmap is ever held, never the full-size picture.
nonisolated func downsampledImage(at url: URL, pixels: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let options = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(1, pixels),
    ] as CFDictionary
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
    return UIImage(cgImage: image)
}
