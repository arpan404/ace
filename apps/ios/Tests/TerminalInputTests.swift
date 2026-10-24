import Testing
@testable import Ace

/// What the phone's terminal sends for key bar taps, keyboard typing and hardware keys.
@Suite struct TerminalInputTests {
    @Test func ctrlTappedOnceAppliesToTheNextTypedCharacterOnly() {
        var modifiers = TerminalModifiers()
        modifiers.ctrl.tap()
        #expect(modifiers.apply(text: "c") == [.key("c", ctrl: true)])
        #expect(modifiers.apply(text: "c") == [.text("c")])
    }

    @Test func aSecondTapLocksTheModifierUntilAThirdReleasesIt() {
        var modifiers = TerminalModifiers()
        modifiers.alt.tap(); modifiers.alt.tap()
        #expect(modifiers.apply(key: "ArrowLeft") == .key("ArrowLeft", alt: true))
        #expect(modifiers.apply(text: "b") == [.key("b", alt: true)])
        modifiers.alt.tap()
        #expect(modifiers.apply(text: "b") == [.text("b")])
    }

    @Test func aHeldModifierTakesOnlyTheFirstCharacterOfAMultiCharacterInsert() {
        var modifiers = TerminalModifiers()
        modifiers.ctrl.tap()
        #expect(modifiers.apply(text: "dx") == [.key("d", ctrl: true), .text("x")])
        modifiers.ctrl.tap()
        #expect(modifiers.apply(text: "\n") == [.key("Enter", ctrl: true)])
    }

    @Test func inputTypedWhileAWriteIsOutWaitsAndGoesNextInOrder() {
        var queue = TerminalSendQueue()
        #expect(queue.add([.text("l")]) == [.text("l")])
        #expect(queue.add([.text("s")]) == nil)
        #expect(queue.add([.text(" -")]) == nil)
        #expect(queue.add([.key("c", ctrl: true)]) == nil)
        #expect(queue.finished() == [.text("s -"), .key("c", ctrl: true)])
        #expect(queue.finished() == nil)
        #expect(queue.add([.key("Escape")]) == [.key("Escape")])
    }

    @Test func switchingTerminalsDropsInputTypedForTheOldOne() {
        var queue = TerminalSendQueue()
        _ = queue.add([.text("a")])
        _ = queue.add([.text("rm")])
        queue.reset()
        #expect(queue.add([.text("b")]) == [.text("b")])
    }

    @Test func hardwareCtrlAndOptionCombosAndNamedKeysGoToTheTerminal() {
        #expect(HardwareKey(character: "c", ctrl: true).input == .key("c", ctrl: true))
        #expect(HardwareKey(character: "f", alt: true).input == .key("f", alt: true))
        #expect(HardwareKey(named: .escape, character: "").input == .key("Escape"))
        #expect(HardwareKey(named: .up, character: "").input == .key("ArrowUp"))
        #expect(HardwareKey(named: .tab, character: "\t", shift: true).input == .key("Tab", shift: true))
        #expect(HardwareKey(named: .function(5), character: "").input == .key("F5"))
    }

    @Test func plainTypingAndCommandShortcutsStayWithTheSystem() {
        #expect(HardwareKey(character: "a").input == nil)
        #expect(HardwareKey(character: "A", shift: true).input == nil)
        #expect(HardwareKey(named: .enter, character: "\r").input == nil)
        #expect(HardwareKey(named: .backspace, character: "").input == nil)
        #expect(HardwareKey(character: "v", command: true).input == nil)
        #expect(HardwareKey(named: .left, character: "", command: true).input == nil)
    }
}
