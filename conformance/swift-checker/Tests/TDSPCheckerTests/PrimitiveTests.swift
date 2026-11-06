import XCTest
@testable import TDSPChecker

/// The building blocks against their own standards, independent of TDSP's vectors.
final class PrimitiveTests: XCTestCase {
    /// FIPS 180-4's examples (and the empty message).
    func testSHA256() {
        func h(_ s: String) -> String { hex(SHA256.hash(Array(s.utf8))) }
        XCTAssertEqual(h(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(h("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(h("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
                       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        XCTAssertEqual(hex(SHA256.hash([UInt8](repeating: 0x61, count: 1_000_000))),
                       "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
    }

    /// RFC 4648 §10's examples, and the canonical form of §1.6.
    func testBase64() {
        for (plain, coded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            XCTAssertEqual(Base64.decodeCanonical(coded), Array(plain.utf8))
            XCTAssertEqual(Base64.encode(Array(plain.utf8)), coded)
        }
        XCTAssertNil(Base64.decodeCanonical("Zh=="), "padding bits set")
        XCTAssertNil(Base64.decodeCanonical("Zg"), "no padding")
        XCTAssertNil(Base64.decodeCanonical("Zg=a"), "padding inside")
        XCTAssertNil(Base64.decodeCanonical("Z-=="), "base64url character")
    }

    /// RFC 8785 §3.2.3's ordering example: by UTF-16 code units.
    func testCanonicalOrdering() throws {
        let names = ["\u{20ac}", "\r", "\u{fb33}", "1", "\u{1f600}", "\u{80}", "\u{f6}"]
        let sorted = names.sorted(by: Canonical.utf16Less)
        XCTAssertEqual(sorted, ["\r", "1", "\u{80}", "\u{f6}", "\u{20ac}", "\u{1f600}", "\u{fb33}"])
        XCTAssertEqual(try Canonical.serialize(.object([("b", .array([.number("1"), .null])), ("a", .string("\u{7f}\u{1}\""))])),
                       "{\"a\":\"\u{7f}\\u0001\\\"\",\"b\":[1,null]}")
    }

    func testJSONStrictness() {
        XCTAssertThrowsError(try JSONParser.parse("{\"a\":1,\"a\":2}", options: .message))
        XCTAssertThrowsError(try JSONParser.parse("{\"a\":\"\\ud800\"}", options: .message))
        XCTAssertNoThrow(try JSONParser.parse("{\"a\":\"\\ud83d\\ude00\"}", options: .message))
        XCTAssertThrowsError(try JSONParser.parse("{\"a\":01}", options: .message))
        XCTAssertThrowsError(try JSONParser.parse("[1]", options: .message))
        let deep32 = String(repeating: "[", count: 31) + String(repeating: "]", count: 31)
        XCTAssertNoThrow(try JSONParser.parse("{\"a\":\(deep32)}", options: .message))
        XCTAssertThrowsError(try JSONParser.parse("{\"a\":[\(deep32)]}", options: .message))
    }

    func testVarUint() throws {
        var r = YjsReader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f])
        XCTAssertEqual(try r.varUint(), (1 << 53) - 1)
        // 2^53: above 2^53 − 1 (Appendix A).
        r = YjsReader([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10])
        XCTAssertThrowsError(try r.varUint())
        // A last byte that takes it far past 2^53 − 1, which lib0 0.2.118 would still return.
        r = YjsReader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
        XCTAssertThrowsError(try r.varUint())
        r = YjsReader([0x80])
        XCTAssertThrowsError(try r.varUint())
        // At most 8 bytes, whatever the value (Appendix A).
        r = YjsReader([0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])
        XCTAssertEqual(try r.varUint(), 1)
        r = YjsReader([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])
        XCTAssertThrowsError(try r.varUint())
    }

    func testProfileIds() {
        for ok in ["a/1", "yjs-paragraphs/1", "com.example.markdown/999999", "a-/1", String(repeating: "a", count: 100) + "/1"] {
            XCTAssertTrue(ProfileId.isValid(ok), ok)
        }
        for bad in ["a/0", "a/01", "-a/1", ".a/1", "A/1", String(repeating: "a", count: 101) + "/1", "a/1000000", "a", "a/"] {
            XCTAssertFalse(ProfileId.isValid(bad), bad)
        }
    }
}
