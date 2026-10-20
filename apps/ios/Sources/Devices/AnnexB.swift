import Foundation

/// H.264 in Annex B (ITU-T H.264 Annex B), as device pictures carry it: NAL units each behind a
/// `00 00 01` or `00 00 00 01` start code, with the sequence and picture parameter sets in front
/// of every keyframe instead of a separate `avcC`. VideoToolbox wants the parameter sets apart
/// and the rest length-prefixed, which these pure helpers produce.
enum AnnexB {
    enum ParseError: Error, Equatable { case noNALUnits }

    static let sequenceParameterSet: UInt8 = 7
    static let pictureParameterSet: UInt8 = 8

    /// The NAL units, without their start codes or trailing zero bytes. Bytes before the first
    /// start code aren't a NAL unit and are skipped.
    static func nalUnits(_ data: Data) -> [Data] {
        let bytes = [UInt8](data)
        var starts: [(code: Int, body: Int)] = []
        var index = 0
        while index + 2 < bytes.count {
            if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
                starts.append((index, index + 3))
                index += 3
            } else {
                index += 1
            }
        }
        var units: [Data] = []
        for (position, entry) in starts.enumerated() {
            let start = entry.body
            var end = position + 1 < starts.count ? starts[position + 1].code : bytes.count
            // A four-byte start code's leading zero, and any trailing zeros, aren't the unit's.
            while end > start, bytes[end - 1] == 0 { end -= 1 }
            if end > start { units.append(Data(bytes[start..<end])) }
        }
        return units
    }

    static func type(_ unit: Data) -> UInt8 { unit[unit.startIndex] & 0x1f }

    /// A keyframe's parameter sets, or nil when it doesn't carry both kinds.
    static func parameterSets(_ data: Data) -> (sequence: [Data], picture: [Data])? {
        let units = nalUnits(data)
        let sequence = units.filter { type($0) == sequenceParameterSet }
        let picture = units.filter { type($0) == pictureParameterSet }
        return sequence.isEmpty || picture.isEmpty ? nil : (sequence, picture)
    }

    /// The access unit as VideoToolbox decodes it: every NAL unit but the parameter sets (which
    /// configure the decoder instead), each behind its four-byte big-endian length.
    static func lengthPrefixed(_ data: Data) throws -> Data {
        let units = nalUnits(data).filter { type($0) != sequenceParameterSet && type($0) != pictureParameterSet }
        guard !units.isEmpty else { throw ParseError.noNALUnits }
        var out = Data(capacity: units.reduce(0) { $0 + 4 + $1.count })
        for unit in units {
            let length = UInt32(unit.count)
            out.append(contentsOf: [UInt8(length >> 24), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff)])
            out.append(unit)
        }
        return out
    }
}
