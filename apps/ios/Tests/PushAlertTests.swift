import CryptoKit
import Foundation
import Testing
import UserNotifications
@testable import Ace

/// Remote push (ADR 0106): the alerts the daemon encrypts to this phone, as the gateway wraps
/// them, opened by the service extension's code (`PushAlert`, `PushCrypto`, `PushKeyStore`).
@Suite @MainActor struct PushAlertTests {
    // MARK: Decrypting what the daemon sent

    @Test(arguments: ["needs_you", "done", "failed", "background_done", "access"])
    func opensAnAlertTheDaemonEncryptedForThisPhone(_ name: String) throws {
        let vectors = try PushVectors.load()
        let push = try vectors.push(name)
        let body = try #require(PushAlert.ciphertext(push.userInfo))
        #expect(PushCrypto.decrypt(body, key: try vectors.key()) == Data(push.plaintext.utf8))
    }

    @Test func aPushForANeedsYouAlertReadsAsTheLocalAlertDoes() throws {
        let vectors = try PushVectors.load()
        let shown = try #require(PushAlert.rewritten(try vectors.push("needs_you").content, key: try vectors.key()))
        #expect(shown.title == "Fix login redirect")
        #expect(shown.body == "Needs you")
        #expect(shown.categoryIdentifier == AlertContent.approvalCategory)
        #expect(shown.interruptionLevel == .timeSensitive)
        #expect(shown.threadIdentifier == "t-auth")
        let info = stringValues(shown.userInfo)
        #expect(info[NotificationKeys.threadId] == "t-auth")
        #expect(info[NotificationKeys.hostId] == "studio")
        #expect(info[NotificationKeys.interactionId] == "i-7")
        #expect(info[NotificationKeys.approve] == "allow-once")
        #expect(info[NotificationKeys.deny] == "deny")
        try expectSameAsLocal(shown, socketFrame: #"{"id":"n:41","threadId":"t-auth","title":"Fix login redirect","status":"needs_you","interactionId":"i-7","backgroundCount":0,"actions":[{"action":"approve","optionId":"allow-once"},{"action":"deny","optionId":"deny"}]}"#)
    }

    @Test func aPushForAFinishedThreadSaysDoneWithItsPreviewAndOffersReply() throws {
        let vectors = try PushVectors.load()
        let shown = try #require(PushAlert.rewritten(try vectors.push("done").content, key: try vectors.key()))
        #expect(shown.title == "Write the README")
        #expect(shown.body == "Done: Added a build section")
        #expect(shown.categoryIdentifier == AlertContent.replyCategory)
        #expect(shown.interruptionLevel == .active)
        try expectSameAsLocal(shown, socketFrame: #"{"id":"n:42","threadId":"t-docs","title":"Write the README","status":"done","backgroundCount":0,"actions":[],"preview":"Added a build section"}"#)
    }

    @Test func aPushForAFailedThreadSaysFailed() throws {
        let vectors = try PushVectors.load()
        let shown = try #require(PushAlert.rewritten(try vectors.push("failed").content, key: try vectors.key()))
        #expect(shown.title == "Fix CI")
        #expect(shown.body == "Failed: bun run test exited 1")
        try expectSameAsLocal(shown, socketFrame: #"{"id":"n:43","threadId":"t-ci","title":"Fix CI","status":"failed","backgroundCount":0,"actions":[],"preview":"bun run test exited 1"}"#)
    }

    @Test func aQuietPushStaysQuiet() throws {
        let vectors = try PushVectors.load()
        let shown = try #require(PushAlert.rewritten(try vectors.push("background_done").content, key: try vectors.key()))
        #expect(shown.body == "3 background tasks done")
        #expect(shown.interruptionLevel == .passive)
        #expect(shown.sound == nil)
    }

    @Test func aPushedSignInAsksAsTheLocalSignInAlertDoes() throws {
        let vectors = try PushVectors.load()
        let shown = try #require(PushAlert.rewritten(try vectors.push("access").content, key: try vectors.key()))
        #expect(shown.title == "Claude wants to sign in to your computer")
        #expect(shown.body == "Code 7KQ2XM · claude.ai")
        let info = stringValues(shown.userInfo)
        #expect(AccessAlert(info: info)?.requestId == "r-9")
        #expect(info[NotificationKeys.hostId] == "studio")
        #expect(info[NotificationKeys.standsFor] == "studio|access:r-9")
    }

    // MARK: Failing closed

    @Test func aTamperedPushKeepsTheGenericText() throws {
        let vectors = try PushVectors.load()
        var push = try vectors.push("done")
        var body = try #require(PushAlert.ciphertext(push.userInfo))
        body[body.count - 20] ^= 0x01
        push.ciphertext = body
        #expect(PushCrypto.decrypt(body, key: try vectors.key()) == nil)
        #expect(PushAlert.rewritten(push.content, key: try vectors.key()) == nil)
    }

    @Test func aPushForAnotherKeyKeepsTheGenericText() throws {
        let vectors = try PushVectors.load()
        let other = PushKey.generate()
        #expect(PushAlert.rewritten(try vectors.push("done").content, key: other) == nil)
    }

    @Test func aPushWithNoKeyOnThePhoneKeepsTheGenericText() throws {
        // A reinstall: the key the machine encrypted to is gone.
        #expect(PushAlert.rewritten(try PushVectors.load().push("done").content, key: nil) == nil)
    }

    @Test(arguments: [0, 21, 86, 103, 140])
    func aTruncatedPushKeepsTheGenericText(_ length: Int) throws {
        let vectors = try PushVectors.load()
        var push = try vectors.push("done")
        push.ciphertext = try #require(PushAlert.ciphertext(push.userInfo)).prefix(length)
        #expect(PushAlert.rewritten(push.content, key: try vectors.key()) == nil)
    }

    @Test func aPushWithoutAnAcePayloadKeepsTheGenericText() throws {
        let content = UNMutableNotificationContent()
        content.title = "ace"; content.body = "New activity"
        content.userInfo = ["ace": ["v": 1, "c": "not base64url!"]]
        #expect(PushAlert.rewritten(content, key: try PushVectors.load().key()) == nil)
        content.userInfo = ["ace": ["v": 2, "c": ""]]
        #expect(PushAlert.rewritten(content, key: try PushVectors.load().key()) == nil)
    }

    @Test func plaintextThatIsNotAnAlertKeepsTheGenericText() throws {
        let key = PushKey.generate()
        for text in [#"{"v":1,"hostId":"studio"}"#, #"{"v":2,"hostId":"studio","notification":{"id":"n","threadId":"t","title":"x","status":"done"}}"#,
                     #"{"v":1,"hostId":"","notification":{"id":"n","threadId":"t","title":"x","status":"done"}}"#, "[]", "done"] {
            #expect(PushAlert.rewritten(try sealedPush(text, to: key), key: key) == nil, "\(text)")
        }
    }

    @Test func anAlertWithMissingOptionalFieldsAndUnknownOnesStillReads() throws {
        let key = PushKey.generate()
        let text = #"{"v":1,"hostId":"studio","later":true,"notification":{"id":"n:9","threadId":"t-1","title":"Ship","status":"done","newField":{"x":1}}}"#
        let shown = try #require(PushAlert.rewritten(try sealedPush(text, to: key), key: key))
        #expect(shown.title == "Ship")
        #expect(shown.body == "Done")
    }

    @Test func anUnknownStatusNeverClaimsDone() throws {
        let key = PushKey.generate()
        let text = #"{"v":1,"hostId":"studio","notification":{"id":"n:9","threadId":"t-1","title":"Ship","status":"paused_forever","backgroundCount":0,"actions":[]}}"#
        let shown = try #require(PushAlert.rewritten(try sealedPush(text, to: key), key: key))
        #expect(shown.body == "New activity")
    }

    // MARK: The key

    @Test func thePhonesPushKeyIsMadeOnceAndTheExtensionReadsTheSameOne() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("push-key-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        // The extension never makes one: before the app does, it has nothing to decrypt with.
        #expect(PushKeyStore(directory: directory).read() == nil)
        let made = try PushKeyStore(directory: directory).loadOrCreate()
        let again = try PushKeyStore(directory: directory).loadOrCreate()
        #expect(made.p256dh == again.p256dh)
        #expect(made.authSecret == again.authSecret)
        #expect(PushKeyStore(directory: directory).read()?.p256dh == made.p256dh)
        #expect(Data(base64URL: made.p256dh)?.count == 65)
        #expect(Data(base64URL: made.authSecret)?.count == 16)
    }

    @Test func theKeyFromTheNodeVectorGivesTheSamePublicHalfNodeComputed() throws {
        let vectors = try PushVectors.load()
        #expect(try vectors.key().p256dh == vectors.p256dh)
        #expect(try vectors.key().authSecret == vectors.auth)
    }

    // MARK: Helpers

    private func expectSameAsLocal(_ shown: UNNotificationContent, socketFrame: String) throws {
        let alert = try JSONDecoder().decode(AlertNotification.self, from: Data(socketFrame.utf8))
        let local = UNMutableNotificationContent()
        AlertContent(alert, hostId: "studio").fill(local)
        #expect(shown.title == local.title)
        #expect(shown.body == local.body)
        #expect(shown.categoryIdentifier == local.categoryIdentifier)
        #expect(shown.interruptionLevel == local.interruptionLevel)
        #expect(shown.threadIdentifier == local.threadIdentifier)
        // Every key a tap or an answer reads is the local alert's, plus the two that tie the
        // push to the alert it stands for.
        var pushed = stringValues(shown.userInfo)
        #expect(pushed.removeValue(forKey: NotificationKeys.pushedAlert) == AlertContent.requestId(alert.id, hostId: "studio"))
        #expect(pushed.removeValue(forKey: NotificationKeys.standsFor) == AlertStack.thread(alert.threadId, hostId: "studio"))
        #expect(pushed == stringValues(local.userInfo))
    }
}
