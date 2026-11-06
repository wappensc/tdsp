// UTF-8 (RFC 3629): what §1.6 calls a string. A validator of its own, so that a byte string
// that is not UTF-8 — an overlong form, an encoded surrogate, a scalar above U+10FFFF — is
// refused the same way on every platform Foundation runs on.

enum UTF8Text {
    /// The Unicode scalars of `bytes`, or nil when they are not UTF-8.
    static func scalars(_ bytes: ArraySlice<UInt8>) -> [Unicode.Scalar]? {
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(bytes.count)
        var i = bytes.startIndex
        let end = bytes.endIndex
        while i < end {
            let b0 = bytes[i]
            if b0 < 0x80 {
                out.append(Unicode.Scalar(b0))
                i += 1
                continue
            }
            let need: Int
            var value: UInt32
            let min: UInt32
            switch b0 {
            case 0xC2...0xDF: need = 1; value = UInt32(b0 & 0x1F); min = 0x80
            case 0xE0...0xEF: need = 2; value = UInt32(b0 & 0x0F); min = 0x800
            case 0xF0...0xF4: need = 3; value = UInt32(b0 & 0x07); min = 0x10000
            default: return nil
            }
            if end - i <= need { return nil }
            for k in 1...need {
                let b = bytes[i + k]
                if b & 0xC0 != 0x80 { return nil }
                value = (value << 6) | UInt32(b & 0x3F)
            }
            if value < min || value > 0x10FFFF || (0xD800...0xDFFF).contains(value) { return nil }
            guard let scalar = Unicode.Scalar(value) else { return nil }
            out.append(scalar)
            i += need + 1
        }
        return out
    }

    /// `bytes` as a String, or nil when they are not UTF-8.
    static func string(_ bytes: ArraySlice<UInt8>) -> String? {
        guard let scalars = scalars(bytes) else { return nil }
        var s = String.UnicodeScalarView()
        s.append(contentsOf: scalars)
        return String(s)
    }

    static func string(_ bytes: [UInt8]) -> String? { string(bytes[...]) }
}

extension String {
    /// The length "in bytes" of §1.6: that of the UTF-8 encoding.
    var utf8Length: Int { utf8.count }
    /// The length "in characters" of §1.6: Unicode code points.
    var codePointCount: Int { unicodeScalars.count }
}
