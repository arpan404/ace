import Foundation
import Testing
@testable import Ace

@Suite struct RemoteScreenRequirementTests {
    @Test(arguments: ["ready", "granted", "n/a", "not-applicable"])
    func satisfiedRequirementsOfferNoRequest(state: String) throws {
        let requirement = try decode(state: state, permission: "accessibility")
        #expect(requirement.requestPermission == nil)
    }

    @Test func futurePermissionsRemainReadableWithoutOfferingAnUnsupportedRequest() throws {
        let requirement = try decode(state: "blocked", permission: "inputMonitoring")
        #expect(requirement.message == "Host instructions")
        #expect(requirement.permission == "inputMonitoring")
        #expect(requirement.requestPermission == nil)
        #expect(try decode(state: "blocked", permission: "accessibility").requestPermission == "accessibility")
    }

    private func decode(state: String, permission: String) throws -> RemoteScreenRequirement {
        let data = Data("""
        {"kind":"access","state":"\(state)","title":"Access","message":"Host instructions","action":"Enable access","permission":"\(permission)"}
        """.utf8)
        return try JSONDecoder().decode(RemoteScreenRequirement.self, from: data)
    }
}
