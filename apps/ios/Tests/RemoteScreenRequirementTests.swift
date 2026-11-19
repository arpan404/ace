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

    @Test func everyPermissionIsListedForReviewAndOnlyAMissingOneOffersToAsk() throws {
        let permissions = try JSONDecoder().decode(RemoteScreenPermissions.self, from: Data(#"{"screenRecording":true,"accessibility":false}"#.utf8))
        let rows = ScreenPermissionRow.rows(permissions)
        #expect(rows.map(\.title) == ["Screen Recording", "Accessibility"])
        #expect(rows.map(\.status) == ["Granted", "Not granted"])
        #expect(rows[0].permission == nil, "a granted permission has nothing to ask for")
        #expect(rows[1].permission == "accessibility")
        #expect(rows[1].action == "Grant access")
    }

    @Test func aMachineThatNamesItsRequirementsIsReviewedInItsOwnWords() throws {
        let json = #"{"screenRecording":false,"accessibility":false,"platform":"linux","requirements":[{"kind":"portal","state":"ready","title":"Screen sharing","message":"The desktop portal is available.","action":null,"permission":null},{"kind":"access","state":"prompt","title":"Accessibility","message":"Allow ace to control apps.","action":"Enable access","permission":"accessibility"}]}"#
        let rows = ScreenPermissionRow.rows(try JSONDecoder().decode(RemoteScreenPermissions.self, from: Data(json.utf8)))
        #expect(rows.map(\.status) == ["Ready", "Needs your approval"])
        #expect(rows.map(\.ready) == [true, false])
        #expect(rows[0].action == nil)
        #expect(rows[1].action == "Enable access")
        #expect(rows[1].permission == "accessibility")
    }

    private func decode(state: String, permission: String) throws -> RemoteScreenRequirement {
        let data = Data("""
        {"kind":"access","state":"\(state)","title":"Access","message":"Host instructions","action":"Enable access","permission":"\(permission)"}
        """.utf8)
        return try JSONDecoder().decode(RemoteScreenRequirement.self, from: data)
    }
}
