import CoreGraphics
import Foundation
import Testing
@testable import Ace

/// Native bot faces: lenient trait decoding from the bridge, size tiers, generated geometry and
/// palette coverage, pose resolution and working eye motion.
@Suite struct BotFaceTests {
    @Test func decodesValidTraitsAndFallsBackToDefaultsForUnknownValues() throws {
        let json = """
        {"body": "sprout", "pair": "sage", "ears": "bunny", "marking": "spots",
         "eyes": "bead", "mouth": "cat", "cheeks": "blush", "accessory": "scarf"}
        """
        let decoded = try JSONDecoder().decode(BotFace.self, from: Data(json.utf8))
        #expect(decoded == BotFace(
            body: .sprout, pair: .sage, ears: .bunny, marking: .spots,
            eyes: .bead, mouth: .cat, cheeks: .blush, accessory: .scarf
        ))

        let future = #"{"body": "dragon", "pair": "neon", "eyes": "big"}"#
        let repaired = try JSONDecoder().decode(BotFace.self, from: Data(future.utf8))
        #expect(repaired.body == BotFace.default.body)
        #expect(repaired.pair == BotFace.default.pair)
        #expect(repaired.eyes == .big)
        #expect(repaired.mouth == BotFace.default.mouth)
    }

    @Test func spadeModelFaceDecodesWithOrWithoutCharacter() throws {
        let withFace = """
        {"main": false, "initial": "R", "away": false,
         "character": {"body": "fox", "pair": "ember", "ears": "none", "marking": "mask",
                       "eyes": "almond", "mouth": "grin", "cheeks": "freckles", "accessory": "glasses"}}
        """
        let bot = try JSONDecoder().decode(SpadeModel.Face.self, from: Data(withFace.utf8))
        #expect(!bot.main && bot.initial == "R" && bot.character?.body == .fox && bot.character?.accessory == .glasses)

        let spade = try JSONDecoder().decode(
            SpadeModel.Face.self,
            from: Data(#"{"main": true, "initial": "S", "away": false, "character": null}"#.utf8)
        )
        #expect(spade.main && spade.character == nil)

        let legacy = try JSONDecoder().decode(
            SpadeModel.Face.self,
            from: Data(#"{"main": false, "initial": "W", "away": true}"#.utf8)
        )
        #expect(legacy.away && legacy.character == nil)
    }

    @Test func tierMatchesUiCoreThresholds() {
        #expect(BotFaceTier(size: 17) == .s)
        #expect(BotFaceTier(size: 24) == .s)
        #expect(BotFaceTier(size: 25) == .m)
        #expect(BotFaceTier(size: 40) == .m)
        #expect(BotFaceTier(size: 41) == .l)
        #expect(BotFaceTier(size: 56) == .l)
    }

    @Test func generatedGeometryCoversEveryBodyPairAndTier() {
        for body in BotFace.Body.allCases {
            let metrics = BotFaceGeometry.body(body)
            #expect(metrics.right > metrics.left)
            for tier in BotFaceTier.allCases {
                let silhouette = BotFaceGeometry.silhouette(body, tier: tier)
                #expect(!silhouette.isEmpty, "Empty silhouette for \(body) at \(tier)")
            }
        }
        for pair in BotFace.Pair.allCases {
            for dark in [false, true] {
                let palette = BotFaceGeometry.palette(for: pair, dark: dark)
                #expect(palette.body <= 0xFFFFFF && palette.accent <= 0xFFFFFF)
                #expect(palette.body != palette.bodyShade)
            }
        }
        for eyes in BotFace.Eyes.allCases {
            let m = BotFaceGeometry.eye(eyes)
            #expect(m.rx > 0 && m.ry > 0 && m.dx > 0)
        }
    }

    @Test func foxSilhouetteFillsBothEarHeadOverlapsWithoutAHole() {
        for tier in BotFaceTier.allCases {
            let fox = BotFaceGeometry.silhouette(.fox, tier: tier)
            // Left and right ear-head overlap regions must both be inside under nonzero winding.
            #expect(fox.contains(CGPoint(x: 6, y: 7.5)), "Left ear overlap missing at \(tier)")
            #expect(fox.contains(CGPoint(x: 18, y: 7.5)), "Right ear overlap missing at \(tier)")
            #expect(fox.contains(CGPoint(x: 4.2, y: 2.5)))
            #expect(fox.contains(CGPoint(x: 19.8, y: 2.5)))
            #expect(fox.contains(CGPoint(x: 12, y: 13)))
            #expect(!fox.contains(CGPoint(x: 12, y: 1)))
        }
    }

    @Test func poseSwapsExpressionsAndSuppressesMouthWhenNone() {
        let smileFace = BotFace(mouth: .smile)
        let doneStyle = BotFacePoseStyle.resolve(pose: .done, face: smileFace, restingLid: 0, motion: nil)
        #expect(doneStyle.happy && doneStyle.mouth == .smile)

        let grinDone = BotFacePoseStyle.resolve(pose: .done, face: BotFace(mouth: .grin), restingLid: 0, motion: nil)
        #expect(grinDone.mouth == .open)

        let blocked = BotFacePoseStyle.resolve(pose: .blocked, face: smileFace, restingLid: 0, motion: nil)
        #expect(blocked.sweat && blocked.mouth == .frown && blocked.lid == 0.48)

        let silent = BotFacePoseStyle.resolve(pose: .needsYou, face: BotFace(mouth: .none), restingLid: 0, motion: nil)
        #expect(silent.mouth == nil)
    }

    @Test func workingMotionBlinksAtMidWindowAndAdvancesTicks() {
        let open = BotFaceMotion.sample(at: 0, thinking: false)
        #expect(open.blinkOpen == 1)

        let midBlink = BotFaceMotion.sample(at: BotFaceMotion.workBlinkCycle * 0.63, thinking: false)
        #expect(abs(midBlink.blinkOpen - BotFaceMotion.closed) < 0.01)

        var t = 0.0
        for _ in 0..<20 {
            let next = BotFaceMotion.nextTick(after: t, thinking: false)
            #expect(next > t)
            t = next
        }
    }
}
