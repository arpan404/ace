import SwiftUI
import UIKit

/// The phone's own look preferences beyond light and dark (Settings › Appearance), kept on this
/// phone as the web keeps its appearance per device.
@MainActor enum PhoneLook {
    static let transcriptKey = "ace.transcriptSize"
    static let reduceMotionKey = "ace.reduceMotion"
    static let solidKey = "ace.solidSurfaces"
    static func scale(_ id: String) -> CGFloat { AceTheme.transcriptSizes.first { $0.id == id }?.scale ?? 1 }
    static func transcriptName(_ id: String) -> String { AceTheme.transcriptSizes.first { $0.id == id }?.name ?? "Default" }
}

extension EnvironmentValues {
    /// Reduce Motion as ace applies it: on whenever the system's is, or when ace's own is on.
    @Entry var aceReduceMotion = false
    /// Floating controls drawn on the solid card colour instead of system glass.
    @Entry var aceSolidSurfaces = false
}

/// Applies the look preferences at the root, so every screen and sheet reads them.
struct PhoneLookEnvironment: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage(PhoneLook.reduceMotionKey) private var reduceMotion = false
    @AppStorage(PhoneLook.solidKey) private var solid = false
    func body(content: Content) -> some View {
        content
            .environment(\.aceReduceMotion, systemReduceMotion || reduceMotion)
            .environment(\.aceSolidSurfaces, solid)
    }
}

/// The transcript's text size, relative to Dynamic Type. Applied to the reading column only.
struct TranscriptTextSize: ViewModifier {
    @AppStorage(PhoneLook.transcriptKey) private var size = "default"
    func body(content: Content) -> some View { content.environment(\.transcriptScale, PhoneLook.scale(size)) }
}

/// A look change fades from the old colours to the new across the whole window, open sheets
/// included: a snapshot of the window as it was fades out over the redrawn one.
@MainActor enum LookCrossfade {
    static func run(_ change: () -> Void) {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        guard let window, let snapshot = window.snapshotView(afterScreenUpdates: false) else { change(); return }
        snapshot.isUserInteractionEnabled = false
        window.addSubview(snapshot)
        change()
        UIView.animate(withDuration: AceTheme.Motion.enter, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
            snapshot.alpha = 0
        } completion: { _ in snapshot.removeFromSuperview() }
    }
}
