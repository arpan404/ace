import SwiftUI
import UIKit

/// The Suit on screen's backdrop (ADR 0150, "On the iPhone"): a still of its scene per scheme,
/// drawn blurred behind the inbox and the transcript with the page colour over it at the
/// readability floor solved for that still (`stillTint`), so every word reads over it. A Suit
/// without a still has no backdrop on a phone. Reading this from a view's body redraws it.
@MainActor @Observable final class SuitStill {
    struct Frame: Equatable { let image: UIImage; let tint: Double }
    static let shared = SuitStill()
    private(set) var light: Frame?
    private(set) var dark: Frame?

    /// The tints solved per still, by "contentHash/scheme", kept so a launch draws at once.
    static let tintsKey = "ace.suit.stillTints"

    func frame(_ scheme: ColorScheme) -> Frame? { scheme == .dark ? dark : light }

    /// Shows `suit`'s stills as fetched and solved before, or none.
    func wear(_ suit: PhoneSuit?, defaults: UserDefaults = .standard) {
        let tints = defaults.dictionary(forKey: Self.tintsKey) as? [String: Double] ?? [:]
        let frame = { (scheme: String, path: String?) -> Frame? in
            guard let suit, let path, let file = SuitAssets.file(suit, path),
                  let tint = tints["\(suit.contentHash)/\(scheme)"], let image = UIImage(contentsOfFile: file.path) else { return nil }
            return Frame(image: image, tint: tint)
        }
        let light = frame("light", suit?.stills.light), dark = frame("dark", suit?.stills.dark)
        if self.light != light { self.light = light }
        if self.dark != dark { self.dark = dark }
    }

    /// Keeps a solved tint for one still, dropping those of other versions.
    static func keep(tint: Double, suit: PhoneSuit, scheme: String, defaults: UserDefaults = .standard) {
        var tints = (defaults.dictionary(forKey: tintsKey) as? [String: Double] ?? [:]).filter { $0.key.hasPrefix(suit.contentHash + "/") }
        tints["\(suit.contentHash)/\(scheme)"] = tint
        defaults.set(tints, forKey: tintsKey)
    }

    /// The still as the phone draws it, averaged into a grid of colours for `stillTint`: the
    /// blur takes out detail finer than a cell.
    nonisolated static func cells(_ image: UIImage, columns: Int = 16, rows: Int = 10) -> [[Int]] {
        guard let cgImage = image.cgImage else { return [] }
        var bytes = [UInt8](repeating: 0, count: columns * rows * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: columns, height: rows, bitsPerComponent: 8, bytesPerRow: columns * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: columns, height: rows))
            return true
        }
        guard drawn else { return [] }
        return stride(from: 0, to: bytes.count, by: 4).map { [Int(bytes[$0]), Int(bytes[$0 + 1]), Int(bytes[$0 + 2])] }
    }
}

extension PhoneLook {
    /// Backdrop: Still or Off, kept on this phone (the web's per-device scene motion).
    static let backdropKey = "ace.suitBackdrop"
}

extension EnvironmentValues {
    /// A Suit's still shows behind the page: lists and the transcript leave their page clear.
    @Entry var aceBackdrop = false
}

extension AceDesign.Size {
    /// How far a Suit's still is blurred behind the page, so words never sit on its detail.
    static let backdropBlur: CGFloat = 28
}

/// The page behind the inbox and the transcript: a Suit's still under the page colour at its
/// floor while a backdrop shows, else the page colour.
struct SuitPageBackground: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.aceBackdrop) private var backdrop
    var body: some View {
        if backdrop, let frame = SuitStill.shared.frame(scheme) {
            Image(uiImage: frame.image)
                .resizable().scaledToFill()
                .blur(radius: AceDesign.Size.backdropBlur, opaque: true)
                .overlay { AceTheme.Colours.background.opacity(frame.tint) }
                .ignoresSafeArea()
                .accessibilityHidden(true)
        } else {
            AceTheme.Colours.background.ignoresSafeArea()
        }
    }
}
