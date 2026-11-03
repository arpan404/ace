import Foundation
import Testing
@testable import Ace

/// The relay channel's encrypted fragments, as the daemon's `apps/relay/src/channel.ts` frames them.
@Suite struct RelayFramingTests {
    private func sessions(rekeyEvery: UInt64 = RelaySession.rekeyInterval) throws -> (RelaySession, RelaySession) {
        let (phone, daemon) = try noisePair()
        return (RelaySession(transport: phone, rekeyEvery: rekeyEvery), RelaySession(transport: daemon, rekeyEvery: rekeyEvery))
    }
    private func deliver(_ frames: [Data], to session: inout RelaySession) throws -> [RelayMessage] {
        try frames.compactMap { try session.open($0) }
    }

    @Test func aLargeJSONMessageCrossesInFullSizeFragmentsAndArrivesWhole() throws {
        var (phone, daemon) = try sessions()
        let text = #"{"type":"command","text":""# + String(repeating: "é", count: 100_000) + #""}"#
        let frames = try phone.seal(text: text)
        // 200 KB of JSON: four fragments, every one but the last the full Noise size.
        #expect(frames.count == 4)
        #expect(frames.dropLast().allSatisfy { $0.count == noiseMaxMessage })
        let received = try deliver(frames, to: &daemon)
        #expect(received == [.text(text)])
    }

    @Test func binaryAndTextMessagesKeepTheirKindsAndOrder() throws {
        var (phone, daemon) = try sessions()
        // Just over one chunk: two binary fragments, within the 64 KiB + 16 limit.
        let bytes = Data((0..<65_540).map { UInt8($0 % 251) })
        var frames = try daemon.seal(binary: bytes)
        frames += try daemon.seal(text: #"{"type":"pong"}"#)
        #expect(try deliver(frames, to: &phone) == [.binary(bytes), .text(#"{"type":"pong"}"#)])
        #expect(throws: RelayFrameError.tooLarge) { try daemon.seal(binary: Data(count: RelaySession.binaryLimit + 1)) }
    }

    @Test func deflatedJSONFromTheDaemonIsInflatedBeforeTheSDKSeesIt() throws {
        var (phone, daemon) = try sessions()
        let text = #"{"type":"snapshot","items":["# + Array(repeating: #"{"id":"item","text":"the same words again"}"#, count: 3000).joined(separator: ",") + "]}"
        let deflated = try RawDeflate.deflate(Data(text.utf8))
        #expect(deflated.count < text.utf8.count / 10)
        #expect(try deliver(try daemon.seal(deflated: deflated), to: &phone) == [.text(text)])
    }

    @Test func aDeflateBombPastTheMessageLimitClosesTheChannel() throws {
        let huge = Data(count: RelaySession.logicalLimit + 1)
        let bomb = try RawDeflate.deflate(huge)
        #expect(throws: RelayFrameError.tooLarge) { try RawDeflate.inflate(bomb, limit: RelaySession.logicalLimit) }
        #expect(throws: RelayFrameError.inflate) { try RawDeflate.inflate(Data([0xff, 0x00, 0x13]), limit: 1024) }
    }

    @Test func bothDirectionsRekeyInStepAndKeepTalking() throws {
        var (phone, daemon) = try sessions(rekeyEvery: 3)
        for round in 0..<10 {
            let out = #"{"n":\#(round)}"#
            #expect(try deliver(try phone.seal(text: out), to: &daemon) == [.text(out)])
            #expect(try deliver(try daemon.seal(text: out), to: &phone) == [.text(out)])
        }
        // A side that rekeys on another schedule can no longer read the other.
        let (a, b) = try noisePair()
        var early = RelaySession(transport: a, rekeyEvery: 1), late = RelaySession(transport: b, rekeyEvery: 4)
        _ = try deliver(try early.seal(text: "{}"), to: &late)
        #expect(throws: NoiseError.decrypt) { try deliver(try early.seal(text: "{}"), to: &late) }
    }

    @Test func aShortNonFinalFragmentOrMixedKindsBreakTheChannel() throws {
        let (a, b) = try noisePair()
        var sender = a, receiver = RelaySession(transport: b)
        // A non-final JSON fragment shorter than the fixed chunk size.
        #expect(throws: RelayFrameError.invalidFragment) { try receiver.open(try sender.send.encrypt(Data([0, 1, 2]))) }

        let (c, d) = try noisePair()
        var mixed = c, mixedReceiver = RelaySession(transport: d)
        var first = Data([0]); first.append(Data(count: RelaySession.chunkSize))
        #expect(try mixedReceiver.open(try mixed.send.encrypt(first)) == nil)
        #expect(throws: RelayFrameError.mixedKinds) { try mixedReceiver.open(try mixed.send.encrypt(Data([3, 1]))) }

        let (e, f) = try noisePair()
        var unknown = e, unknownReceiver = RelaySession(transport: f)
        #expect(throws: RelayFrameError.invalidFragment) { try unknownReceiver.open(try unknown.send.encrypt(Data([6, 1]))) }
    }

    @Test func theDaemonsChannelCloseBecomesTheSocketsCloseCode() {
        #expect(RelaySocket.channelClose(#"{"type":"channel.close","code":4003,"reason":"revoked"}"#) == 4003)
        #expect(RelaySocket.channelClose(#"{"type":"channel.close","code":99,"reason":""}"#) == nil)
        #expect(RelaySocket.channelClose(#"{"type":"error","code":4003}"#) == nil)
    }

    @Test func theHelloOffersDeflateExceptOnSignInChannels() throws {
        let hello = #"{"type":"hello","protocolVersion":1,"deviceId":"ios-1","grant":"g"}"#
        let offered = try #require(try JSONSerialization.jsonObject(with: Data(RelaySocket.offeringCompression(hello).utf8)) as? [String: Any])
        #expect(offered["compression"] as? [String] == ["deflate-raw"])
        #expect(offered["grant"] as? String == "g")
        let signIn = #"{"type":"hello","channel":"provider_auth","grant":"g"}"#
        #expect(RelaySocket.offeringCompression(signIn) == signIn)
        let command = #"{"type":"command"}"#
        #expect(RelaySocket.offeringCompression(command) == command)
    }
}
