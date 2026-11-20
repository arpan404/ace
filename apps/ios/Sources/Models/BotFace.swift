import CoreGraphics
import Foundation

/// A bot's character face traits from `@ace/ui-core/bot-face/model.ts`.
/// Every field decodes leniently, falling back to `BotFace.default` for unknown values.
struct BotFace: Equatable, Hashable, Sendable, Decodable {
    enum Body: String, CaseIterable, Sendable, Equatable, Hashable {
        case round, blob, pebble, sprout, ghost, bot, fox, bird, cloud, bean
    }
    enum Pair: String, CaseIterable, Sendable, Equatable, Hashable {
        case ember, butter, mint, lagoon, sky, lilac, rose, berry, sage, cocoa, stone
    }
    enum Ears: String, CaseIterable, Sendable, Equatable, Hashable {
        case none, cat, bear, bunny, tuft, nubs
    }
    enum Marking: String, CaseIterable, Sendable, Equatable, Hashable {
        case none, cap, mask, muzzle, patch, stripes, spots
    }
    enum Eyes: String, CaseIterable, Sendable, Equatable, Hashable {
        case egg, round, big, sleepy, almond, bead
    }
    enum Mouth: String, CaseIterable, Sendable, Equatable, Hashable {
        case none, smile, open, cat, o, grin
    }
    enum Cheeks: String, CaseIterable, Sendable, Equatable, Hashable {
        case none, blush, freckles
    }
    enum Accessory: String, CaseIterable, Sendable, Equatable, Hashable {
        case none, headphones, glasses, beanie, scarf, bow, flower
    }

    let body: Body
    let pair: Pair
    let ears: Ears
    let marking: Marking
    let eyes: Eyes
    let mouth: Mouth
    let cheeks: Cheeks
    let accessory: Accessory

    static let `default` = BotFace(
        body: .round,
        pair: .ember,
        ears: .none,
        marking: .none,
        eyes: .egg,
        mouth: .smile,
        cheeks: .none,
        accessory: .none
    )

    init(
        body: Body = .round,
        pair: Pair = .ember,
        ears: Ears = .none,
        marking: Marking = .none,
        eyes: Eyes = .egg,
        mouth: Mouth = .smile,
        cheeks: Cheeks = .none,
        accessory: Accessory = .none
    ) {
        self.body = body
        self.pair = pair
        self.ears = ears
        self.marking = marking
        self.eyes = eyes
        self.mouth = mouth
        self.cheeks = cheeks
        self.accessory = accessory
    }

    private enum CodingKeys: String, CodingKey {
        case body, pair, ears, marking, eyes, mouth, cheeks, accessory
    }

    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        func pick<T: RawRepresentable>(_ key: CodingKeys, fallback: T) -> T where T.RawValue == String {
            guard let raw = try? box.decodeIfPresent(String.self, forKey: key), let value = T(rawValue: raw) else {
                return fallback
            }
            return value
        }
        self.body = pick(.body, fallback: Self.default.body)
        self.pair = pick(.pair, fallback: Self.default.pair)
        self.ears = pick(.ears, fallback: Self.default.ears)
        self.marking = pick(.marking, fallback: Self.default.marking)
        self.eyes = pick(.eyes, fallback: Self.default.eyes)
        self.mouth = pick(.mouth, fallback: Self.default.mouth)
        self.cheeks = pick(.cheeks, fallback: Self.default.cheeks)
        self.accessory = pick(.accessory, fallback: Self.default.accessory)
    }
}

/// Detail level by rendered point size (`ui-core/bot-face/draw-shared.ts`): `s ≤ 24`, `m ≤ 40`, `l` above.
enum BotFaceTier: Sendable, Equatable, CaseIterable {
    case s, m, l

    init(size: CGFloat) {
        if size <= 24 { self = .s }
        else if size <= 40 { self = .m }
        else { self = .l }
    }
}

/// What the face expresses for the bot's state (`ui-core/bot-face/states.ts`).
enum BotFacePose: Sendable, Equatable, Hashable {
    case idle, working, thinking, needsYou, blocked, done, sleeping

    var isMoving: Bool { self == .working || self == .thinking }
}
