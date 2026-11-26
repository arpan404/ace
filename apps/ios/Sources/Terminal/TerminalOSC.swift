import Foundation

/// One of the terminal's own colours: the default ink, the page or the cursor (OSC 10, 11, 12).
enum TerminalSpecialColour: Int, Sendable {
    case foreground
    case background
    case cursor

    /// The OSC number that sets or asks for this colour.
    var code: Int { self == .foreground ? 10 : self == .background ? 11 : 12 }
}

/// What a program asked of the terminal through an operating-system command (OSC), parsed from
/// the text between `ESC ]` and its terminator. Pure: `TerminalScreen` applies what comes out.
/// Only the commands the web's xterm handles are recognised; anything else parses to nothing.
enum TerminalOSC: Equatable, Sendable {
    /// OSC 0 and 2: the window title.
    case title(String)
    /// OSC 8: start a hyperlink, or end the current one with nil.
    case hyperlink(String?)
    /// OSC 4: set or ask for one of the 256 indexed palette colours.
    case setIndexed(index: Int, colour: TerminalColour)
    case queryIndexed(index: Int)
    /// OSC 10, 11, 12: set or ask for one of the terminal's own colours.
    case setSpecial(TerminalSpecialColour, TerminalColour)
    case querySpecial(TerminalSpecialColour)
    /// OSC 104: restore the given indexes, or all of them when the list is empty.
    case resetIndexed([Int])
    /// OSC 110, 111, 112.
    case resetSpecial(TerminalSpecialColour)

    /// The most actions one OSC string may carry, so a hostile payload can't spin.
    static let maxActions = 512
    /// The most scalars a hyperlink's address may hold; longer addresses are dropped.
    static let maxLinkScalars = 1_024

    static func parse(_ text: String) -> [TerminalOSC] {
        let separator = text.firstIndex(of: ";")
        let codeText = separator.map { text[..<$0] } ?? text[...]
        guard let code = number(codeText) else { return [] }
        let value = separator.map { String(text[text.index(after: $0)...]) } ?? ""
        switch code {
        case 0, 2: return [.title(value)]
        case 4: return indexed(value)
        case 8: return hyperlink(value)
        case 10...12: return special(value, start: code - 10)
        case 104: return [.resetIndexed(indexes(value))]
        case 110...112: return [.resetSpecial(TerminalSpecialColour(rawValue: code - 110) ?? .foreground)]
        default: return []
        }
    }

    /// A hyperlink's address as a URL the phone may open. Local files and script schemes name the
    /// machine that runs the shell, not this phone, so they are not followed.
    static func openable(_ address: String) -> URL? {
        guard let url = URL(string: address),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }

    // MARK: Parsing pieces

    /// `4;1;#ff0000;2;?` and its `:`-free xterm forms: pairs of index and colour or `?`.
    private static func indexed(_ value: String) -> [TerminalOSC] {
        let slots = value.split(separator: ";", omittingEmptySubsequences: false)
        var actions: [TerminalOSC] = []
        var index = 0
        while index + 1 < slots.count, actions.count < maxActions {
            defer { index += 2 }
            guard let slot = number(slots[index]), (0...255).contains(slot) else { continue }
            if slots[index + 1] == "?" { actions.append(.queryIndexed(index: slot)) }
            else if let colour = colour(slots[index + 1]) { actions.append(.setIndexed(index: slot, colour: colour)) }
        }
        return actions
    }

    /// `8;params;uri`. xterm takes the URI from the first semicolon on, so an unencoded `;` in
    /// the address survives. An empty URI ends the current link; an `id` with no URI changes
    /// nothing, as in xterm. Addresses too long to keep end the link rather than mislabel text.
    private static func hyperlink(_ value: String) -> [TerminalOSC] {
        guard let separator = value.firstIndex(of: ";") else { return [] }
        let parameters = value[..<separator].trimmingCharacters(in: .whitespaces)
        let address = String(value[value.index(after: separator)...])
        if address.isEmpty { return parameters.isEmpty ? [.hyperlink(nil)] : [] }
        guard address.unicodeScalars.count <= maxLinkScalars else { return [.hyperlink(nil)] }
        return [.hyperlink(address)]
    }

    /// OSC 10, 11 or 12 may stack colours: each one after the first moves to the next slot, as
    /// xterm does, so `10;fg;bg` sets both.
    private static func special(_ value: String, start: Int) -> [TerminalOSC] {
        let slots = value.split(separator: ";", omittingEmptySubsequences: false)
        var actions: [TerminalOSC] = []
        for (offset, spec) in slots.enumerated() where start + offset < 3 {
            guard let slot = TerminalSpecialColour(rawValue: start + offset) else { continue }
            if spec == "?" { actions.append(.querySpecial(slot)) }
            else if let colour = colour(spec) { actions.append(.setSpecial(slot, colour)) }
        }
        return actions
    }

    /// OSC 104's indexes; none means every index.
    private static func indexes(_ value: String) -> [Int] {
        value.split(separator: ";", omittingEmptySubsequences: false).prefix(maxActions).compactMap {
            number($0).flatMap { (0...255).contains($0) ? $0 : nil }
        }
    }

    /// xterm's colour forms: `rgb:h/h/h` with one to four hex digits a channel, or `#` followed
    /// by three, six, nine or twelve hex digits. Named colours are not understood.
    static func colour(_ spec: Substring) -> TerminalColour? {
        let text = spec.trimmingCharacters(in: .whitespaces).lowercased()
        if text.hasPrefix("rgb:") {
            let parts = text.dropFirst(4).split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 3 else { return nil }
            let channels = parts.map { component($0) }
            guard let red = channels[0], let green = channels[1], let blue = channels[2] else { return nil }
            return .rgb(red, green, blue)
        }
        guard text.hasPrefix("#") else { return nil }
        let digits = text.dropFirst()
        guard [3, 6, 9, 12].contains(digits.count), digits.allSatisfy(\.isHexDigit) else { return nil }
        let width = digits.count / 3
        let channels = (0..<3).map { part -> Int in
            let start = digits.index(digits.startIndex, offsetBy: part * width)
            let end = digits.index(start, offsetBy: width)
            let value = Int(digits[start..<end], radix: 16) ?? 0
            switch width {
            case 1: return value << 4
            case 3: return value >> 4
            case 4: return value >> 8
            default: return value
            }
        }
        return .rgb(channels[0], channels[1], channels[2])
    }

    /// One `rgb:` channel: one to four hex digits, scaled to 8 bits as xterm's `parseColor` does.
    private static func component(_ digits: Substring) -> Int? {
        let count = digits.count
        guard (1...4).contains(count), digits.allSatisfy(\.isHexDigit),
              let value = Int(digits, radix: 16) else { return nil }
        let most = (1 << (count * 4)) - 1
        return Int((Double(value) / Double(most) * 255).rounded())
    }

    /// A decimal number, strictly digits: `+4` and ` 4` are not OSC numbers.
    private static func number(_ text: some StringProtocol) -> Int? {
        guard !text.isEmpty, text.count <= 6, text.allSatisfy(\.isASCII), text.allSatisfy(\.isNumber),
              let value = Int(text) else { return nil }
        return value
    }
}
