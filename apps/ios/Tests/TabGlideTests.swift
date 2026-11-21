import CoreGraphics
import Testing
@testable import Ace

/// The home bar's chosen fill following a finger along the places and settling on one.
struct TabGlideTests {
    /// The phone's bar: four places sharing 320 points, no gap.
    private let phone = TabGlide(count: 4, width: 320, spacing: 0)
    /// The iPad sidebar's foot: four 44-point places with 4-point gaps.
    private let sidebar = TabGlide(count: 4, width: 4 * 44 + 3 * 4, spacing: 4)

    @Test func eachPlaceGetsAnEqualShareOfTheRowLessTheGaps() {
        #expect(phone.slot == 80)
        #expect(sidebar.slot == 44)
    }

    @Test func aReleaseChoosesThePlaceUnderTheFinger() {
        #expect(phone.index(at: 10) == 0)
        #expect(phone.index(at: 79) == 0)
        #expect(phone.index(at: 81) == 1)
        #expect(phone.index(at: 200) == 2)
        #expect(phone.index(at: 319) == 3)
    }

    @Test func aFingerInTheGapBetweenTwoPlacesGoesToTheNearerOne() {
        // The gap between the first and second places runs from 44 to 48.
        #expect(sidebar.index(at: 45) == 0)
        #expect(sidebar.index(at: 47) == 1)
    }

    @Test func aFingerPastEitherEndOfTheBarChoosesTheEndPlace() {
        #expect(phone.index(at: -40) == 0)
        #expect(phone.index(at: 500) == 3)
    }

    @Test func theFillCentresUnderTheFingerAsItSlides() {
        #expect(phone.offset(following: 120) == 80)
        #expect(phone.offset(following: 150) == 110)
        // Moving the finger by a point moves the fill by a point: it glides, never steps.
        #expect(phone.offset(following: 151) - phone.offset(following: 150) == 1)
    }

    @Test func theFillStaysInsideTheBarWhenTheFingerRunsPastAnEnd() {
        #expect(phone.offset(following: 5) == 0)
        #expect(phone.offset(following: -60) == 0)
        #expect(phone.offset(following: 310) == 240)
        #expect(phone.offset(following: 900) == 240)
    }

    @Test func theFillSettlesExactlyOnTheChosenPlace() {
        #expect(phone.offset(of: 2) == 160)
        #expect(sidebar.offset(of: 1) == 48)
        #expect(sidebar.offset(of: 3) == 144)
        // The place a release chooses is the one the fill was mostly over.
        let x: CGFloat = 130
        let settled = phone.offset(of: phone.index(at: x))
        #expect(abs(settled - phone.offset(following: x)) <= phone.slot / 2)
    }

    private func point(_ x: CGFloat, _ y: CGFloat = 20) -> CGPoint { CGPoint(x: x, y: y) }

    @Test func aSlideEndingOnAnotherPlacePicksIt() {
        #expect(phone.release(from: point(40), at: point(200), held: 1, chosen: 0) == 2)
    }

    @Test func aTapPicksItsPlaceEvenWhenItIsAlreadyChosen() {
        #expect(phone.release(from: point(120), at: point(120), held: 0.1, chosen: 1) == 1)
        #expect(phone.release(from: point(120), at: point(124, 24), held: 0.1, chosen: 1) == 1)
    }

    @Test func aSlideThatComesBackToTheChosenPlacePicksNothing() {
        #expect(phone.release(from: point(100), at: point(130), held: 0.3, chosen: 1) == nil)
        #expect(phone.release(from: point(100), at: point(260), held: 0.3, chosen: 1) == 3)
    }

    @Test func aVerticalSwipeFromTheChosenPlaceIsNotARetap() {
        #expect(phone.release(from: point(120), at: point(122, -40), held: 0.2, chosen: 1) == nil)
        #expect(phone.release(from: point(120), at: point(120, 32), held: 0.2, chosen: 1) == nil)
    }

    @Test func aLongPressOnTheChosenPlaceIsNotARetap() {
        #expect(phone.release(from: point(120), at: point(120), held: 0.8, chosen: 1) == nil)
        // On another place a long press still picks it.
        #expect(phone.release(from: point(200), at: point(200), held: 0.8, chosen: 1) == 2)
    }

    @Test func anUnmeasuredBarKeepsTheFillOnTheFirstPlace() {
        let unmeasured = TabGlide(count: 4, width: 0, spacing: 0)
        #expect(unmeasured.index(at: 50) == 0)
        #expect(unmeasured.offset(following: 50) == 0)
        #expect(unmeasured.offset(of: 2) == 0)
    }
}
