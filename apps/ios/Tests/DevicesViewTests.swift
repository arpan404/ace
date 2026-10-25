import CoreGraphics
import Foundation
import Testing
@testable import Ace

/// The Devices screen draws what the bridge shapes (`bridge/devices-view.ts`), and a device's
/// frame fits the room the stage has.
@MainActor @Suite struct DevicesViewTests {
    private static let frame = #"{"bezel":{"top":0.045,"right":0.045,"bottom":0.045,"left":0.045},"screenRadius":0.14,"bodyRadius":0.185,"band":0.012,"homeButton":false}"#
    private static let patch = #"""
    {"type":"devices.view","threadId":"thread-1","view":{"connected":true,"loading":false,"enabled":true,"offline":null,
     "running":[{"id":"ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b","name":"iPhone 17 Pro","platform":"ios","kind":"iphone","detail":"iOS 26.0 · Live","running":true,"live":true,"control":"Claude is using it"}],
     "groups":[{"label":"Android phone","rows":[{"id":"android:Pixel_9","name":"Pixel 9","platform":"android","kind":"android-phone","detail":"Android 15 · Off","running":false,"live":false,"control":""}]}],
     "notes":[{"message":"A device tool is missing on this machine.","hint":"Install the device and recording tools, then try again."}],
     "toolsMissing":true,
     "device":{"id":"ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b","name":"iPhone 17 Pro","platform":"ios","kind":"iphone","subtitle":"iOS 26.0 · Live","where":"Live",
       "live":true,"running":true,"busy":false,"cleanupRequired":false,"recording":false,"interactive":false,
       "control":{"sentence":"Claude is using iPhone 17 Pro","action":"take"},
       "buttons":[{"label":"Volume up","key":"volumeUp"}],"frame":{"portrait":FRAME,"landscape":FRAME},
       "screen":{"width":393,"height":852},
       "activity":{"sequence":3,"caption":"tap @e7 “Sign in”","provider":"claude","x":20,"y":40},"problem":null,"touch":"gestures"}}}
    """#.replacingOccurrences(of: "FRAME", with: frame)

    @Test func theBridgesDevicesViewReachesTheScreenWithWhoControlsEachDevice() throws {
        let patch = try JSONDecoder().decode(BridgePatch.self, from: Data(Self.patch.utf8))
        guard case .devices(let devices) = patch else { Issue.record("Expected a devices patch"); return }
        let model = DevicesModel()
        model.apply(devices)
        let view = try #require(model.view)
        #expect(view.running.map(\.control) == ["Claude is using it"])
        #expect(view.groups.first?.rows.first?.name == "Pixel 9")
        #expect(view.notes.first?.text == "A device tool is missing on this machine. Install the device and recording tools, then try again.")
        let device = try #require(view.device)
        #expect(device.control.sentence == "Claude is using iPhone 17 Pro")
        #expect(device.control.action == "take")
        #expect(device.interactive == false)
        #expect(device.activity?.caption == "tap @e7 “Sign in”")
        #expect(device.frame.portrait.screenRadius == 0.14)
    }

    @Test func aFrameFitsItsRoomKeepsTheScreensAspectAndNeverBlowsUpASmallScreen() throws {
        let geometry = try JSONDecoder().decode(DeviceFrameGeometry.self, from: Data(Self.frame.utf8))
        let screen = CGSize(width: 393, height: 852)
        for room in [CGSize(width: 300, height: 900), CGSize(width: 900, height: 300)] {
            let layout = DeviceFrameLayout(room: room, geometry: geometry, screen: screen)
            #expect(layout.body.width <= room.width + 0.001 && layout.body.height <= room.height + 0.001)
            #expect(abs(layout.screen.height / layout.screen.width - 852 / 393) < 0.0001)
            #expect(abs(max(layout.body.width / room.width, layout.body.height / room.height) - 1) < 0.0001)
        }
        let large = DeviceFrameLayout(room: CGSize(width: 4000, height: 4000), geometry: geometry, screen: screen)
        #expect(large.screen.width == 393)
    }
}
