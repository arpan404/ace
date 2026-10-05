import Foundation

/// One submitted sample plus one replaceable changed sample. Completion drains even on idle sources.
enum VideoEncodeResult { case submitted, busy, unavailable }
final class LatestVideoFrames<Image> {
    private var pending: Image?
    private let submit: (Image) -> VideoEncodeResult
    init(submit: @escaping (Image) -> VideoEncodeResult) { self.submit = submit }
    func offer(_ image: Image) { pending = image; completed() }
    func completed() {
        guard let image = pending else { return }
        switch submit(image) {
        case .busy: break
        case .submitted, .unavailable: pending = nil
        }
    }
    func clear() { pending = nil }
}

/// Tracking is erased only after a successful release or confirmed original-target destruction.
final class HeldPointer<Target> {
    private(set) var target: Target?
    func hold(_ target: Target) { self.target = target }
    func release(post: (Target) throws -> Void) throws {
        guard let target else { return }
        try post(target)
        self.target = nil
    }
    func targetDestroyed() { target = nil }
}
enum InputPermission {
    static func require(_ granted: Bool) throws {
        guard granted else { throw HelperError("macOS permission denied", code: "permission_denied") }
    }
}
/// Platform clocks and permission checks are supplied at the native I/O boundary.
struct NativeRuntime {
    let nanos: () -> UInt64
    let milliseconds: () -> Double
    let uptime: () -> Double
    let inputAllowed: () -> Bool
}

/// Single posting boundary shared by ordinary input and cleanup; permissions are checked per event.
enum NativeInputPost {
    static func perform(permission: () -> Bool, post: () throws -> Void) throws {
        try InputPermission.require(permission())
        try post()
    }
}

/// A cold screenshot request survives suspension until real pixels arrive. Requests coalesce.
final class CaptureImages<Image> {
    private(set) var latest: Image?
    private var requested = false
    func request() -> Image? {
        if let latest { return latest }
        requested = true
        return nil
    }
    func receive(_ image: Image) -> Image? {
        latest = image
        guard requested else { return nil }
        requested = false
        return image
    }
    func clear() { latest = nil; requested = false }
}
