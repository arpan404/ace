import Foundation
import Testing
@testable import Ace

@Suite struct PairingRedemptionTests {
    @Test func theCodeAndTheStandingKeyGoOnlyInTheRedemptionsBody() throws {
        let code = String(repeating: "c0de", count: 16)
        let key = String(repeating: "B", count: 87)
        let request = try PairingRedemption.request(code: code, name: "Arpan's iPhone", installId: "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b",
                                                    standingKey: key)
        #expect(request.method == "POST")
        #expect(request.path == "/v1/pair")
        #expect(request.token == nil)
        let body = try #require(try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8)) as? [String: String])
        #expect(body == ["code": code, "name": "Arpan's iPhone", "installId": "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b", "standingKey": key])
    }

    @Test func aPhoneWithoutASecureEnclaveNamesNoKey() throws {
        let request = try PairingRedemption.request(code: "c", name: "Phone", installId: nil, standingKey: nil)
        let body = try #require(try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8)) as? [String: String])
        #expect(body == ["code": "c", "name": "Phone"])
    }

    @Test func theBridgeIsHandedTheMachinesAnswerOrWhyTheTransportRefused() {
        let answered = PairingRedemption.answer(.success(PinnedHTTPResponse(status: 401, body: "{}")))
        #expect(answered["status"] as? Int == 401)
        #expect(answered["body"] as? String == "{}")
        #expect(PairingRedemption.answer(.failure(.pin))["refused"] as? String == "pin")
    }
}
