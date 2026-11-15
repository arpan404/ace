import Foundation
import Observation

/// A Suit as the bridge resolves it for this phone (`@ace/suits/phone`): the colour roles per
/// scheme, the font slots, corner and hairline scale, density and a still per scheme. Swift draws
/// what this says and decides nothing about a Suit itself.
struct PhoneSuit: Codable, Equatable, Sendable {
    struct Face: Codable, Equatable, Sendable {
        /// `assets/…` of a bundled font file, or nil for installed families.
        let asset: String?
        let families: [String]
    }
    struct Faces: Codable, Equatable, Sendable { let ui: Face?; let prose: Face?; let mono: Face? }
    struct Stills: Codable, Equatable, Sendable { let light: String?; let dark: String? }
    let id: String
    let name: String
    let description: String
    let contentHash: String
    let schemes: [String]
    /// Scheme → colour role → "#RRGGBB".
    let colours: [String: [String: String]]
    let fonts: Faces
    let radius: Double
    let border: Double
    /// "comfortable" or "compact" over the device's own density; nil keeps it.
    let density: String?
    let stills: Stills
    /// Why this phone won't show it; nil when it can.
    let unavailable: String?

    /// The colour roles as light and dark pairs, as the palette model takes them.
    var pairs: [String: NativePalette.Pair] {
        var pairs: [String: NativePalette.Pair] = [:]
        for (role, light) in colours["light"] ?? [:] {
            guard let light = Self.hex(light), let dark = colours["dark"]?[role].flatMap(Self.hex) else { continue }
            pairs[role] = .init(light: light, dark: dark)
        }
        return pairs
    }

    private static func hex(_ text: String) -> UInt32? {
        guard text.count == 7, text.first == "#" else { return nil }
        return UInt32(text.dropFirst(), radix: 16)
    }
}

/// A Suit in the Look grid, before it is read (`suits.list`).
struct PhoneSuitRow: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let description: String
    let contentHash: String
    let schemes: [String]
    /// Why it can't be picked; nil when it can.
    let unavailable: String?
}

/// What an agent's `suit_apply` asks of this device (`SuitActive` in @ace/protocol).
enum SuitActive: Decodable, Equatable, Sendable {
    case preview(String)
    case none
    case keep(String, keepId: String)
    case restore(keepId: String)

    private enum Keys: String, CodingKey { case kind, suitId, keepId }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .kind) {
        case "preview": self = .preview(try box.decode(String.self, forKey: .suitId))
        case "keep": self = .keep(try box.decode(String.self, forKey: .suitId), keepId: try box.decode(String.self, forKey: .keepId))
        case "restore": self = .restore(keepId: try box.decode(String.self, forKey: .keepId))
        default: self = .none
        }
    }
}

/// Which Suit this phone shows (ADR 0150): the device's own setting (`appearance.suit`, kept on
/// this phone), an agent's preview over it, and the Suit as last read. A Suit shows only while it
/// is wanted, listed as appliable and readable on this phone; anything else falls back to the
/// chosen theme. The Suit last applied is kept, so a launch draws it before any machine answers.
@MainActor @Observable final class SuitLookModel {
    /// The Suit this device picked; nil for the theme.
    private(set) var setting: String?
    /// What was on before the last pick (nil: the theme), for one step back; nil before any pick.
    private(set) var previous: String??
    /// An agent's preview over the setting, until it ends; not stored.
    private(set) var preview: String??
    /// The Suit on screen; nil while the theme shows.
    private(set) var applied: PhoneSuit?
    /// The wanted Suit and why it isn't on screen, when it can't be.
    private(set) var refusal: (id: String, reason: String)?
    @ObservationIgnored private let defaults: UserDefaults
    /// Each agent's keep, so its undo puts back what this device had: keep id → (kept, before).
    @ObservationIgnored private var undos: [String: (kept: String, before: String?)] = [:]
    /// Each Suit as last read, so the setting shows again at once when a preview ends.
    @ObservationIgnored private var held: [String: PhoneSuit] = [:]

    static let settingKey = "ace.suit"
    static let previousKey = "ace.suit.previous"
    static let appliedKey = "ace.suit.applied"

    init(defaults: UserDefaults) {
        self.defaults = defaults
        setting = defaults.string(forKey: Self.settingKey)
        if let before = defaults.object(forKey: Self.previousKey) as? String { previous = .some(before.isEmpty ? nil : before) }
        let cached = defaults.data(forKey: Self.appliedKey).flatMap { try? JSONDecoder().decode(PhoneSuit.self, from: $0) }
        if let cached, cached.id == setting, cached.unavailable == nil {
            applied = cached
            held[cached.id] = cached
        }
    }

    /// The Suit asked for now: an agent's preview while one runs, else the setting.
    var wanted: String? { preview ?? setting }

    /// The person picks a Suit, or the theme with nil; the look before it can be put back.
    func choose(_ id: String?) {
        guard id != setting else { return }
        previous = .some(setting)
        defaults.set(setting ?? "", forKey: Self.previousKey)
        store(id)
    }

    /// One step back to the look before the last pick.
    func revert() {
        guard case .some(let before) = previous else { return }
        choose(before)
    }

    /// An agent's preview, keep or revert, as the web's library hears it.
    func hear(_ active: SuitActive) {
        switch active {
        case .preview(let id): preview = .some(id); settle()
        case .none: preview = nil; settle()
        case .keep(let id, let keepId):
            preview = nil
            undos[keepId] = (kept: id, before: setting)
            choose(id)
        case .restore(let keepId):
            // The person picked something else since: theirs stays.
            guard let undo = undos.removeValue(forKey: keepId), setting == undo.kept else { return }
            choose(undo.before)
        }
    }

    /// The wanted Suit as read; it shows unless this phone can't draw it.
    func show(_ suit: PhoneSuit) {
        guard suit.id == wanted else { return }
        if let reason = suit.unavailable { refuse(suit.id, reason: reason); return }
        refusal = nil
        held[suit.id] = suit
        if applied != suit { applied = suit }
        // Only the device's own pick is kept for the next launch; a preview isn't.
        if suit.id == setting, let data = try? JSONEncoder().encode(suit) { defaults.set(data, forKey: Self.appliedKey) }
    }

    /// The wanted Suit can't show: its machine lists it as failing its checks, or it is gone.
    func refuse(_ id: String, reason: String) {
        guard id == wanted else { return }
        refusal = (id, reason)
        held[id] = nil
        if applied != nil { applied = nil }
    }

    private func store(_ id: String?) {
        setting = id
        if let id { defaults.set(id, forKey: Self.settingKey) } else { defaults.removeObject(forKey: Self.settingKey) }
        settle()
    }

    /// Shows the wanted Suit as last read, or the theme until it is read.
    private func settle() {
        if let refusal, refusal.id != wanted { self.refusal = nil }
        let next = wanted.flatMap { held[$0] }
        if applied != next { applied = next }
        if setting == nil { defaults.removeObject(forKey: Self.appliedKey) }
    }
}

/// The model PhoneAppearance registers at the root, for agents' pushes from any machine.
@MainActor enum SuitLooks {
    static var model: SuitLookModel?
}

/// The Suit on screen's shape (ADR 0150): its corner scale over the phone's fixed radii and its
/// hairline width. Capsules and concentric shapes stay what the design language makes them.
/// Reading these from a view's body redraws it when the Suit changes.
@MainActor @Observable final class SuitShape {
    static let shared = SuitShape()
    private(set) var radius: CGFloat = 1
    private(set) var border: CGFloat = 1
    func wear(radius: CGFloat, border: CGFloat) {
        if self.radius != radius { self.radius = radius }
        if self.border != border { self.border = border }
    }
}
