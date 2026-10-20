import Foundation
import Observation

struct NativePalette: Codable, Equatable, Sendable {
    struct Pair: Codable, Equatable, Sendable { var light: UInt32; var dark: UInt32 }
    var colours: [String: Pair] = [:]
    static let editable = ["background", "secondaryBackground", "card", "foreground", "mutedForeground", "subtleForeground", "separator", "fill", "accent", "onAccent"]
    func validated() throws -> NativePalette {
        guard colours.count <= Self.editable.count, colours.allSatisfy({ Self.editable.contains($0.key) && $0.value.light <= 0xFFFFFF && $0.value.dark <= 0xFFFFFF }) else {
            throw PaletteError.invalid
        }
        return self
    }
}
enum PaletteError: Error { case invalid }

/// App-owned UI preferences, registered with the token adapter by PhoneAppearance.
/// The generated theme holds no palette state of its own: widget extensions never
/// register a model and keep the shared token defaults.
@MainActor @Observable final class NativePaletteModel {
    private(set) var palette: NativePalette
    @ObservationIgnored private let defaults: UserDefaults
    static let key = "ace.palette"
    init(defaults: UserDefaults) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key), data.count <= 8192,
           let read = try? JSONDecoder().decode(NativePalette.self, from: data), let valid = try? read.validated() { palette = valid }
        else { palette = NativePalette() }
    }
    func save(_ next: NativePalette) throws {
        let valid = try next.validated()
        defaults.set(try JSONEncoder().encode(valid), forKey: Self.key)
        palette = valid
    }
    func reset() { defaults.removeObject(forKey: Self.key); palette = NativePalette() }
}

/// Live bridge between the injected palette model and the generated token adapter.
///
/// The app registers its model once (PhoneAppearance at the root). Registration goes
/// through an observable box, so the first registration after launch re-evaluates
/// every view that already resolved token defaults; later saves and resets invalidate
/// through the model's palette. Neither path resets navigation identity, and
/// `NativeTextInput.updateUIView` picks the new colours up on that pass. Widgets and
/// previews leave the reference unset and resolve to the token defaults passed in by
/// the generated code.
@MainActor enum NativePaletteBridge {
    @Observable final class Registration {
        var model: NativePaletteModel?
    }
    static let registration = Registration()
    static var model: NativePaletteModel? {
        get { registration.model }
        set { registration.model = newValue }
    }
    static func pair(for key: String, light: UInt32, dark: UInt32) -> NativePalette.Pair {
        if let override = registration.model?.palette.colours[key] { return override }
        return NativePalette.Pair(light: light, dark: dark)
    }
}
