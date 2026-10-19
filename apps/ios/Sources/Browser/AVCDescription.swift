import Foundation

/// H.264's decoder configuration record (`avcC`, ISO/IEC 14496-15 §5.2.4.1), as a video
/// keyframe's description carries it: the parameter sets VideoToolbox needs and how many bytes
/// prefix each NAL unit's length in the chunks.
///
///     u8 version (1), u8 profile, u8 compatibility, u8 level,
///     u8 111111xx: NAL length size − 1,
///     u8 111xxxxx: sequence parameter set count, then each: u16 length, bytes
///     u8 picture parameter set count, then each: u16 length, bytes
///     (High profiles may append chroma fields, which aren't needed here.)
struct AVCDescription: Equatable, Sendable {
    let profile: UInt8
    let level: UInt8
    let nalLengthSize: Int
    let sequenceParameterSets: [Data]
    let pictureParameterSets: [Data]

    enum ParseError: Error, Equatable { case short, version, noParameterSets }

    init(_ record: Data) throws {
        let reader = ByteReader(record)
        guard reader.count >= 7 else { throw ParseError.short }
        guard reader.u8(0) == 1 else { throw ParseError.version }
        profile = reader.u8(1)
        level = reader.u8(3)
        nalLengthSize = Int(reader.u8(4) & 0b11) + 1
        var at = 5
        /// A count byte (masked), then that many length-prefixed sets.
        func sets(mask: UInt8) throws -> [Data] {
            guard at < reader.count else { throw ParseError.short }
            let count = Int(reader.u8(at) & mask)
            at += 1
            var found: [Data] = []
            for _ in 0..<count {
                guard at + 2 <= reader.count else { throw ParseError.short }
                let length = Int(reader.u16(at))
                guard length > 0, at + 2 + length <= reader.count else { throw ParseError.short }
                found.append(reader.slice(at + 2, length))
                at += 2 + length
            }
            return found
        }
        sequenceParameterSets = try sets(mask: 0b1_1111)
        pictureParameterSets = try sets(mask: 0xff)
        guard !sequenceParameterSets.isEmpty, !pictureParameterSets.isEmpty else { throw ParseError.noParameterSets }
    }
}
