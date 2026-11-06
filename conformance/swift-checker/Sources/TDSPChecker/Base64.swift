// Base64 as §1.6 fixes it: the standard alphabet with padding (RFC 4648 §4), and only its
// canonical form — the bits the padding discards are zero (RFC 4648 §3.5), so one text encodes
// one byte string.

enum Base64 {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)
    private static let values: [UInt8: UInt8] = {
        var m: [UInt8: UInt8] = [:]
        for (i, c) in alphabet.enumerated() { m[c] = UInt8(i) }
        return m
    }()

    /// The bytes of a canonical, padded Base64 text, or nil.
    static func decodeCanonical(_ text: String) -> [UInt8]? {
        let chars = Array(text.utf8)
        guard chars.count % 4 == 0 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(chars.count / 4 * 3)
        var i = 0
        while i < chars.count {
            let last = i + 4 == chars.count
            var pad = 0
            if last {
                if chars[i + 3] == 0x3D { pad = 1 }
                if pad == 1, chars[i + 2] == 0x3D { pad = 2 }
            }
            var v = [UInt8](repeating: 0, count: 4)
            for k in 0..<(4 - pad) {
                guard let d = values[chars[i + k]] else { return nil }
                v[k] = d
            }
            out.append(v[0] << 2 | v[1] >> 4)
            if pad < 2 { out.append(v[1] << 4 | v[2] >> 2) }
            if pad < 1 { out.append(v[2] << 6 | v[3]) }
            // The discarded bits must be zero.
            if pad == 2, v[1] & 0x0F != 0 { return nil }
            if pad == 1, v[2] & 0x03 != 0 { return nil }
            i += 4
        }
        return out
    }

    static func encode(_ bytes: [UInt8]) -> String {
        var out: [UInt8] = []
        var i = 0
        while i < bytes.count {
            let n = min(3, bytes.count - i)
            let b0 = bytes[i], b1 = n > 1 ? bytes[i + 1] : 0, b2 = n > 2 ? bytes[i + 2] : 0
            out.append(alphabet[Int(b0 >> 2)])
            out.append(alphabet[Int((b0 & 0x03) << 4 | b1 >> 4)])
            out.append(n > 1 ? alphabet[Int((b1 & 0x0F) << 2 | b2 >> 6)] : 0x3D)
            out.append(n > 2 ? alphabet[Int(b2 & 0x3F)] : 0x3D)
            i += 3
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// A device tag (§4.3): 22 characters of base64url without padding (RFC 4648 §5).
    static func isDeviceTag(_ text: String) -> Bool {
        let chars = Array(text.utf8)
        return chars.count == 22 && chars.allSatisfy { c in
            (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) || c == 0x2D || c == 0x5F
        }
    }
}
