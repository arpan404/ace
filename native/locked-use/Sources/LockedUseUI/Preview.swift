import AppKit

public enum LockedUsePreviewError: Error { case renderingUnavailable }

/// Produces reviewable native pixels without creating panels, input taps or an OS session.
public enum LockedUsePreview {
    @MainActor public static func png() throws -> Data {
        let view = LockedUseCoverView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800))
        view.appearance = NSAppearance(named: .darkAqua)
        view.showPreview()
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw LockedUsePreviewError.renderingUnavailable }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { throw LockedUsePreviewError.renderingUnavailable }
        return data
    }
}
