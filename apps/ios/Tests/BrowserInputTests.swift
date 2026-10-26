import CoreGraphics
import Foundation
import Testing
import UIKit
@testable import Ace

/// The person's input on the live page: where a finger lands in the page, the touch points the
/// page gets, typing through the hidden field, the keyboard it asks for and picker values.
@Suite struct BrowserInputTests {
    // MARK: Geometry

    @Test func aPictureNarrowerThanTheViewIsCentredAndPointsMapIntoItsCSSPixels() {
        // A 400×800 page in a 600×800 view: 1:1 height, 100 points of margin each side.
        let geometry = PageGeometry(view: CGSize(width: 600, height: 800), page: CGSize(width: 400, height: 800))
        #expect(geometry.box == CGRect(x: 100, y: 0, width: 400, height: 800))
        #expect(geometry.pagePoint(CGPoint(x: 300, y: 400)) == CGPoint(x: 200, y: 400))
        // A finger in the margin stays on the page's edge.
        #expect(geometry.pagePoint(CGPoint(x: 20, y: 900)) == CGPoint(x: 0, y: 800))
        #expect(geometry.viewRect(PageRect(x: 10, y: 20, width: 100, height: 30)) == CGRect(x: 110, y: 20, width: 100, height: 30))
    }

    @Test func aPageRenderedLargerThanTheViewScalesDown() {
        let geometry = PageGeometry(view: CGSize(width: 390, height: 700), page: CGSize(width: 780, height: 1400))
        #expect(geometry.pagePoint(CGPoint(x: 195, y: 350)) == CGPoint(x: 390, y: 700))
        #expect(geometry.viewRect(PageRect(x: 780, y: 0, width: 0, height: 0)).minX == 390)
        #expect(!geometry.movable)
    }

    @Test func aPhoneTallerThanTheViewFitsItsWidthFromTheTopAndTwoFingersMoveIt() {
        // An iPhone 16 Pro page (402×874) in a 402×650 view: 1:1, the bottom 224 points below.
        let geometry = PageGeometry(view: CGSize(width: 402, height: 650), page: CGSize(width: 402, height: 874))
        #expect(geometry.box == CGRect(x: 0, y: 0, width: 402, height: 874))
        #expect(geometry.movable)
        // Moved up by more than there is: it stops with the page's bottom at the view's.
        let moved = geometry.panned(by: CGPoint(x: 30, y: -500))
        #expect(moved.box == CGRect(x: 0, y: -224, width: 402, height: 874))
        // A finger at the view's top is now 224 CSS pixels down the page.
        #expect(moved.pagePoint(CGPoint(x: 100, y: 0)) == CGPoint(x: 100, y: 224))
        #expect(moved.viewRect(PageRect(x: 0, y: 300, width: 10, height: 10)).minY == 76)
    }

    @Test func aDesktopPageFitsThePhonesWidthAndZoomsAroundTheFingers() {
        // A 1280×800 laptop page in a 400×700 view: drawn at 0.3125, 250 points tall, at the top.
        let geometry = PageGeometry(view: CGSize(width: 400, height: 700), page: CGSize(width: 1280, height: 800))
        #expect(geometry.box == CGRect(x: 0, y: 0, width: 400, height: 250))
        #expect(!geometry.movable)
        // Pinched to 2× around (100, 50): the finger stays over the same place across; the page,
        // still shorter than the view, stays at the top.
        let zoomed = geometry.zoomed(by: 2, around: CGPoint(x: 100, y: 50))
        #expect(zoomed.movable)
        #expect(zoomed.box == CGRect(x: -100, y: 0, width: 800, height: 500))
        #expect(zoomed.pagePoint(CGPoint(x: 100, y: 50)) == CGPoint(x: 320, y: 80))
        // Never smaller than the fit, never past 4×.
        #expect(zoomed.zoomed(by: 0.1, around: .zero).box == geometry.box)
        #expect(geometry.zoomed(by: 100, around: .zero).zoom == PageGeometry.maxZoom)
    }

    // MARK: Touch

    @Test func everyFingerOnThePageIsATouchPointWithAStableSlot() {
        var tracker = TouchTracker<Int>()
        #expect(tracker.began([(7, CGPoint(x: 10, y: 20))]) == .touch(event: "touchStart", points: [.init(x: 10, y: 20, id: 0)]))
        // A second finger (a pinch): both points, the first keeping its slot.
        #expect(tracker.began([(8, CGPoint(x: 50, y: 60))]) == .touch(event: "touchStart", points: [.init(x: 10, y: 20, id: 0), .init(x: 50, y: 60, id: 1)]))
        #expect(tracker.moved([(8, CGPoint(x: 70, y: 80))]) == .touch(event: "touchMove", points: [.init(x: 10, y: 20, id: 0), .init(x: 70, y: 80, id: 1)]))
        // A move to the same place says nothing.
        #expect(tracker.moved([(8, CGPoint(x: 70, y: 80))]) == nil)
        // The first finger lifts: the page sees a move without it, then the last one up ends it.
        #expect(tracker.ended([7]) == .touch(event: "touchMove", points: [.init(x: 70, y: 80, id: 1)]))
        #expect(tracker.ended([8]) == .touch(event: "touchEnd", points: []))
        // A new sequence starts from slot 0 again.
        #expect(tracker.began([(9, CGPoint(x: 1, y: 2))]) == .touch(event: "touchStart", points: [.init(x: 1, y: 2, id: 0)]))
        #expect(tracker.cancelled() == .touch(event: "touchCancel", points: []))
        #expect(tracker.cancelled() == nil)
    }

    @Test func theEleventhFingerIsIgnored() {
        var tracker = TouchTracker<Int>()
        _ = tracker.began((0..<10).map { ($0, CGPoint(x: Double($0), y: 0)) })
        #expect(tracker.began([(10, CGPoint(x: 99, y: 99))]) == nil)
        #expect(tracker.moved([(10, CGPoint(x: 1, y: 1))]) == nil)
        #expect(tracker.ended([10]) == nil)
        #expect(tracker.active == 10)
    }

    @Test func touchesTravelAsTheProtocolsTouchInput() {
        let json = RemoteInput.touch(event: "touchMove", points: [.init(x: 1.5, y: 2, id: 3)]).json
        #expect(json["kind"] as? String == "touch")
        #expect(json["event"] as? String == "touchMove")
        let points = json["points"] as? [[String: Any]]
        #expect(points?.first?["x"] as? Double == 1.5)
        #expect(points?.first?["id"] as? Int == 3)
        #expect(RemoteInput.pick(pickerId: "p", values: nil).json["values"] == nil)
    }

    // MARK: Typing

    @Test func typedCharactersReachThePageAsTextAtItsCaret() {
        var typing = RemoteTyping()
        #expect(typing.update(plain: "h", caret: 1, marked: nil) == [.key(event: "char", key: "Unidentified", text: "h")])
        #expect(typing.update(plain: "hi", caret: 2, marked: nil) == [.key(event: "char", key: "Unidentified", text: "i")])
        // Backspace in the local field is Backspace in the page.
        #expect(typing.update(plain: "h", caret: 1, marked: nil) == RemoteTyping.backspace)
    }

    @Test func autocorrectReplacingTheWordBehindTheCaretRetypesIt() {
        var typing = RemoteTyping()
        _ = typing.update(plain: "teh", caret: 3, marked: nil)
        let inputs = typing.update(plain: "the ", caret: 4, marked: nil)
        #expect(inputs == RemoteTyping.backspace + RemoteTyping.backspace + [.key(event: "char", key: "Unidentified", text: "he ")])
    }

    @Test func textAfterTheCaretIsDeletedForward() {
        let edit = RemoteTyping.edit(before: "abcd", caretBefore: 2, after: "abd", caretAfter: 2)
        #expect(edit == RemoteTyping.Edit(backspaces: 0, deletes: 1, text: ""))
    }

    @Test func anEmojiIsOneBackspaceAndNeverSplit() {
        let edit = RemoteTyping.edit(before: "a👍🏽", caretBefore: 5, after: "a", caretAfter: 1)
        #expect(edit == RemoteTyping.Edit(backspaces: 1, deletes: 0, text: ""))
        // Two emoji sharing a lead surrogate: the edit starts before the whole character.
        let swap = RemoteTyping.edit(before: "😀", caretBefore: 2, after: "😃", caretAfter: 2)
        #expect(swap == RemoteTyping.Edit(backspaces: 1, deletes: 0, text: "😃"))
    }

    @Test func aPastedParagraphIsSentInPiecesWithLineBreaksAsEnter() {
        let long = String(repeating: "é", count: 300)
        let inputs = RemoteTyping.inputs(for: RemoteTyping.Edit(text: "one\n" + long))
        #expect(inputs.first == .key(event: "char", key: "Unidentified", text: "one"))
        #expect(Array(inputs[1...2]) == RemoteTyping.enter)
        let pieces = inputs.dropFirst(3).compactMap { input -> String? in
            if case .key("char", _, _, let text) = input { return text } else { return nil }
        }
        #expect(pieces.joined() == long)
        #expect(pieces.allSatisfy { $0.utf16.count <= 256 })
    }

    @Test func anIMECompositionIsShownMarkedThenCommittedAsText() {
        var typing = RemoteTyping()
        #expect(typing.update(plain: "", caret: 0, marked: "に") == [.ime(text: "に", selectionStart: 1, selectionEnd: 1)])
        #expect(typing.update(plain: "", caret: 0, marked: "にほ") == [.ime(text: "にほ", selectionStart: 2, selectionEnd: 2)])
        // Committing: the text arrives as typed text, which ends the page's composition.
        #expect(typing.update(plain: "日本", caret: 2, marked: nil) == [.key(event: "char", key: "Unidentified", text: "日本")])
        #expect(typing.composing == nil)
    }

    @Test func anAbandonedCompositionIsCancelledInThePage() {
        var typing = RemoteTyping()
        #expect(typing.update(plain: "a", caret: 1, marked: "k") == [.key(event: "char", key: "Unidentified", text: "a"), .ime(text: "k", selectionStart: 1, selectionEnd: 1)])
        #expect(typing.update(plain: "a", caret: 1, marked: nil) == [.ime(text: "", selectionStart: 0, selectionEnd: 0)])
        // Nothing changed since: nothing is sent.
        #expect(typing.update(plain: "a", caret: 1, marked: nil).isEmpty)
    }

    @Test func theKeyboardMatchesThePagesField() {
        let rect = PageRect(x: 0, y: 0, width: 10, height: 10)
        let email = KeyboardStyle(.init(type: "email", rect: rect))
        #expect(email.keyboard == .emailAddress && !email.assisted && !email.secure)
        let password = KeyboardStyle(.init(type: "password", rect: rect))
        #expect(password.secure && !password.assisted)
        // The page's own inputmode and enterkeyhint win over the type.
        let code = KeyboardStyle(.init(type: "text", rect: rect, inputMode: "numeric", enterKeyHint: "send"))
        #expect(code.keyboard == .numberPad && code.returnKey == .send && code.assisted)
        #expect(KeyboardStyle(.init(type: "search", rect: rect)).returnKey == .search)
    }

    // MARK: Pickers

    @Test func pickerValuesRoundTripInTheirHTMLFormats() throws {
        for (kind, value) in [("date", "2026-10-19"), ("time", "09:05"), ("datetime-local", "2026-02-28T23:30"), ("month", "2026-10"), ("week", "2026-W43")] {
            let date = try #require(PickerValues.date(value, kind: kind), "\(kind)")
            #expect(PickerValues.string(date, kind: kind) == value)
        }
        // A time with seconds reads; it is written back in the input's minutes.
        let seconds = try #require(PickerValues.date("07:08:09", kind: "time"))
        #expect(PickerValues.string(seconds, kind: "time") == "07:08")
        #expect(PickerValues.date("19/10/2026", kind: "date") == nil)
        #expect(PickerValues.date("2026-10-19", kind: "select") == nil)
    }

    @Test func coloursTravelAsLowercaseHex() {
        let rgb = PickerValues.rgb("#FF8000")
        #expect(rgb?.red == 255 && rgb?.green == 128 && rgb?.blue == 0)
        #expect(PickerValues.rgb("#12345") == nil)
        #expect(PickerValues.hex(red: 1, green: 0.5, blue: 1.2) == "#ff80ff")
    }
}
