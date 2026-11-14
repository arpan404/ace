import Foundation

/// HEVCDecoderConfigurationRecord (ISO/IEC 14496-15): 23 fixed bytes followed by
/// typed arrays of u16-length-prefixed NAL units. Unknown arrays are safely skipped.
struct HEVCDescription: Equatable, Sendable {
    let nalLengthSize: Int
    let parameterSets: [Data]
    enum ParseError: Error { case short, version, invalid, noParameterSets }
    init(_ record: Data) throws {
        let reader = ByteReader(record)
        guard reader.count >= 23 else { throw ParseError.short }
        guard reader.u8(0) == 1 else { throw ParseError.version }
        nalLengthSize = Int(reader.u8(21) & 3) + 1
        guard nalLengthSize != 3 else { throw ParseError.invalid }
        var at = 23
        var arrays: [UInt8: [Data]] = [:]
        for _ in 0..<Int(reader.u8(22)) {
            guard at + 3 <= reader.count else { throw ParseError.short }
            let type = reader.u8(at) & 63
            let count = Int(reader.u16(at + 1))
            at += 3
            for _ in 0..<count {
                guard at + 2 <= reader.count else { throw ParseError.short }
                let length = Int(reader.u16(at))
                at += 2
                guard length >= 2, at + length <= reader.count else { throw ParseError.short }
                let unit = reader.slice(at, length)
                guard AnnexB.hevcType(unit) == type else { throw ParseError.invalid }
                arrays[type, default: []].append(unit)
                at += length
            }
        }
        guard at == reader.count else { throw ParseError.invalid }
        guard [UInt8(32), 33, 34].allSatisfy({ !(arrays[$0] ?? []).isEmpty }) else { throw ParseError.noParameterSets }
        parameterSets = [UInt8(32), 33, 34].flatMap { arrays[$0] ?? [] }
    }
}
