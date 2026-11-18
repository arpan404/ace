import Testing
@testable import Ace

struct ScannerModelTests {
    @Test func aPhoneWithoutACameraOffersPasteWhateverThePermissionSays() {
        for access in [CameraAccess.allowed, .undecided, .denied, .restricted] {
            let model = ScannerModel(access: access, hasCamera: false)
            #expect(model.phase == .noCamera)
            #expect(!model.showsCamera)
            #expect(!model.offersSettings)
        }
    }

    @Test func deniedAndRestrictedAccessOfferSettingsInsteadOfACamera() {
        let denied = ScannerModel(access: .denied, hasCamera: true)
        #expect(denied.phase == .denied)
        #expect(denied.offersSettings && !denied.showsCamera)
        let restricted = ScannerModel(access: .restricted, hasCamera: true)
        #expect(restricted.phase == .restricted)
        #expect(restricted.offersSettings && !restricted.showsCamera)
    }

    @Test func theCameraStartsOnlyOnceThePersonAllowsIt() {
        var model = ScannerModel(access: .undecided, hasCamera: true)
        #expect(model.phase == .asking)
        model.answered(granted: true)
        #expect(model.phase == .scanning)
        #expect(model.showsCamera)

        var refused = ScannerModel(access: .undecided, hasCamera: true)
        refused.answered(granted: false)
        #expect(refused.phase == .denied)
        #expect(refused.offersSettings)
    }

    @Test func aLateAnswerDoesNotRestartAScanThatAlreadyEnded() {
        var model = ScannerModel(access: .allowed, hasCamera: true)
        #expect(model.read("https://host/pair#a", problem: nil) == .accepted)
        model.answered(granted: true)
        #expect(model.phase == .found("https://host/pair#a"))
    }

    @Test func aCameraThatWontStartReadsAsNoCamera() {
        var model = ScannerModel(access: .allowed, hasCamera: true)
        model.cameraFailed()
        #expect(model.phase == .noCamera)
    }

    @Test func theFirstGoodCodeIsHandedBackOnceAndLaterReadsAreIgnored() {
        var model = ScannerModel(access: .allowed, hasCamera: true)
        #expect(model.read("https://host/pair#a", problem: nil) == .accepted)
        #expect(model.phase == .found("https://host/pair#a"))
        #expect(model.read("https://host/pair#b", problem: nil) == .ignored)
        #expect(model.phase == .found("https://host/pair#a"))
    }

    @Test func aCodeThatIsNotAPairingLinkKeepsScanningAndSaysWhyOnce() {
        var model = ScannerModel(access: .allowed, hasCamera: true)
        #expect(model.read("https://example.com", problem: "That isn't a pairing code.") == .rejected)
        #expect(model.phase == .scanning)
        #expect(model.note == "That isn't a pairing code.")
        // The same code still in view is read every frame: one rejection, not one per frame.
        #expect(model.read("https://example.com", problem: "That isn't a pairing code.") == .ignored)
        #expect(model.read("https://host/pair#a", problem: nil) == .accepted)
        #expect(model.note == nil)
    }

    @Test func nothingIsReadBeforeTheCameraRuns() {
        var model = ScannerModel(access: .undecided, hasCamera: true)
        #expect(model.read("https://host/pair#a", problem: nil) == .ignored)
        #expect(model.phase == .asking)
    }
}
