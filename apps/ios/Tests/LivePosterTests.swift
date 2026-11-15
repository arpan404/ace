import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import Ace

/// The subscribe reply's poster (ADR 0149): taken out on the socket's queue, drawn natively until
/// the first live picture, and never passed on to the script.
@Suite struct LivePosterTests {
    /// A real JPEG of `width` × `height`, as ace-media's still path makes one.
    private func jpeg(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
    private func reply(_ type: String, poster: [String: Any]?) throws -> String {
        var media: [String: Any] = ["connection": "mc_aaaaaaaa"]
        if let poster { media["poster"] = poster }
        let message: [String: Any] = ["type": type, "requestId": "r1", "ok": true, "media": media]
        return String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    @Test func eachLiveViewsReplyGivesUpItsPosterAndKeepsItsConnection() throws {
        let bytes = try jpeg(width: 64, height: 40)
        let poster: [String: Any] = ["width": 64, "height": 40, "jpeg": bytes.base64EncodedString()]
        for (type, kind) in [("browser.result", LivePoster.Kind.browser), ("screen.result", .screen), ("devices.result", .device)] {
            let (rest, taken) = PosterReply.take(try reply(type, poster: poster))
            #expect(taken == PosterReply.Taken(kind: kind, width: 64, height: 40, jpeg: bytes), "\(type)")
            let media = try #require(try object(rest)["media"] as? [String: Any])
            #expect(media["poster"] == nil && media["connection"] as? String == "mc_aaaaaaaa", "\(type)")
            #expect(!rest.contains(bytes.base64EncodedString()))
        }
    }

    @Test func messagesWithoutAPosterPassUntouched() throws {
        let plain = try reply("browser.result", poster: nil)
        #expect(PosterReply.take(plain).text == plain && PosterReply.take(plain).poster == nil)
        // A page's own words naming a poster, in a message that isn't a subscribe reply.
        let state = #"{"type":"browser.state","state":{"title":"The \"poster\" shop","media":{"poster":1}}}"#
        #expect(PosterReply.take(state).text == state && PosterReply.take(state).poster == nil)
    }

    @Test func aPosterOutsideTheSchemasBoundsIsDroppedNotPassedOn() throws {
        let big = String(repeating: "A", count: 64 * 1024 + 4)
        for poster: [String: Any] in [["width": 0, "height": 40, "jpeg": "AAAA"], ["width": 64, "height": 9000, "jpeg": "AAAA"],
                                      ["width": 64, "height": 40, "jpeg": big], ["width": 64, "height": 40, "jpeg": "not base64!"]] {
            let (rest, taken) = PosterReply.take(try reply("screen.result", poster: poster))
            #expect(taken == nil)
            #expect((try object(rest)["media"] as? [String: Any])?["poster"] == nil)
        }
    }

    @Test func thePostersJPEGDecodesAtItsSizeAndGarbageDecodesToNothing() throws {
        let taken = PosterReply.Taken(kind: .browser, width: 64, height: 40, jpeg: try jpeg(width: 64, height: 40))
        let poster = try #require(PosterReply.decode(taken))
        #expect(poster.image.width == 64 && poster.image.height == 40 && poster.kind == .browser)
        #expect(PosterReply.decode(PosterReply.Taken(kind: .device, width: 1, height: 1, jpeg: Data([1, 2, 3]))) == nil)
    }

    @Test func thePosterShowsUntilTheFirstLivePictureAndNeverAfter() throws {
        let image = try #require(PosterReply.decode(PosterReply.Taken(kind: .screen, width: 8, height: 8, jpeg: try jpeg(width: 8, height: 8))))
        var gate = PosterGate()
        let shows = gate.offer(image.image)
        #expect(shows && gate.shown != nil)
        let hides = gate.pictureDrawn()
        #expect(hides && gate.shown == nil)
        // A later subscribe's poster (a reconnect) never covers the live picture.
        let covers = gate.offer(image.image)
        let hidesAgain = gate.pictureDrawn()
        #expect(!covers && !hidesAgain)
        // A live picture before any poster: the poster that arrives late is never shown.
        var late = PosterGate()
        let nothingToHide = late.pictureDrawn()
        let lateShows = late.offer(image.image)
        #expect(!nothingToHide && !lateShows)
    }
}
