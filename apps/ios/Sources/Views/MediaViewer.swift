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
        // VoiceOver's scrub gesture closes it too.
        .accessibilityAction(.escape) { dismiss() }
        .task {
            guard image == nil else { return }
            image = await load()
            failed = image == nil
        }
    }

    /// A file on the phone, decoded for viewing off the main thread (`ImageDecoding.viewed`).
    static func image(at url: URL) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { ImageDecoding.source(at: url).flatMap(ImageDecoding.viewed) }.value
    }
    /// Base64 bytes from the bridge, decoded from text and as an image together off the main thread.
    static func image(base64: String) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            Data(base64Encoded: base64).flatMap(ImageDecoding.source).flatMap(ImageDecoding.viewed)
        }.value
    }
}
