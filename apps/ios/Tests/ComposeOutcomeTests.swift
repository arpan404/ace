import Foundation
import Testing
@testable import Ace

@Suite struct ComposeOutcomeTests {
    private func decode(_ json: String) throws -> ComposePatch {
        try JSONDecoder().decode(ComposePatch.self, from: Data(json.utf8))
    }

    @Test func aFolderOutsideTheProjectFoldersOffersAllowThisFolder() throws {
        let patch = try decode(#"{"type":"compose.added","id":"add-1","ok":false,"projectId":null,"message":"ace isn't allowed to open this folder yet.","canAllow":true}"#)
        guard case .added(let id, let outcome) = patch else { Issue.record("not an Add project answer"); return }
        #expect(id == "add-1")
        #expect(outcome.ok == false)
        #expect(outcome.canAllow)
    }
    @Test func anyOtherRefusalOffersNothingToAllow() throws {
        let patch = try decode(#"{"type":"compose.added","id":"add-2","ok":false,"projectId":null,"message":"That folder doesn't exist."}"#)
        guard case .added(_, let outcome) = patch else { Issue.record("not an Add project answer"); return }
        #expect(!outcome.canAllow)
    }
}
