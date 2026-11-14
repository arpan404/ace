import Foundation
import Testing
@testable import Ace

/// A machine page's Software, from the bridge's words (`bridge/machine-software.ts`, whose tests
/// run the update on a fake machine): what the phone asks for each action, and that an update
/// under way keeps the page following it.
struct MachineSoftwareTests {
    @Test func updateNowCarriesTheAgentsThePersonAgreedToStop() {
        let now = MachineSoftwareData.act("now", name: "studio", access: "admin", agents: 2)
        #expect(now["action"] as? String == "now")
        #expect(now["agents"] as? Int == 2)
        let idle = MachineSoftwareData.act("idle", name: "studio", access: "admin")
        #expect(idle["agents"] == nil, "waiting for idle stops no agents")
    }

    @Test func anUpdateUnderWayIsFollowedUntilItsResult() throws {
        let json = #"{"line":"ace 0.0.18. 0.0.19 is available.","progress":"Downloading 0.0.19 · 40%","progressTone":"off","actions":[{"action":"cancel","label":"Cancel update"}],"link":null,"note":null,"confirm":{"title":"Update studio now?","body":"Nothing is working there. ace restarts to 0.0.19.","confirm":"Update now","agents":0},"updating":true,"problem":null}"#
        let page = try JSONDecoder().decode(MachineSoftwareData.self, from: Data(json.utf8))
        #expect(page.updating)
        #expect(page.actions.map(\.action) == ["cancel"])
        #expect(page.confirm?.agents == 0)
    }

    @Test func aRefusalIsShownInThePersonsWords() throws {
        let json = #"{"line":"ace 0.0.18. 0.0.19 is available.","progress":null,"progressTone":"off","actions":[],"link":null,"note":"This window can only read this machine. Pair it again as Administrator to update it.","confirm":null,"updating":false,"problem":"This window can only read studio. Pair it again as Administrator to update it."}"#
        let page = try JSONDecoder().decode(MachineSoftwareData.self, from: Data(json.utf8))
        #expect(page.actions.isEmpty)
        #expect(page.problem?.contains("can only read studio") == true)
    }
}
