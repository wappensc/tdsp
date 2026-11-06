/// What names the edition of TDSP this checker reads, in one place: the marker that frames and
/// invitations carry in place of the version while 2.0 is a draft (VER-3), and the name the vector
/// files carry for it. Releasing 2.0 changes these lines and nothing else of the file names.
public enum Edition {
    /// VER-3: the draft marker in place of `2`.
    public static let marker = "de.wappensc.together.tdsp.probe.draft-10"

    /// The suffix of this edition's vector and wire files: `frames-<suffix>.json`.
    public static let fileSuffix = "draft-10"

    /// A published test vector file of this edition, relative to the specification's directory.
    public static func vectors(_ name: String) -> String {
        "packages/document-protocol/test-vectors/\(name)-\(fileSuffix).json"
    }

    /// A wire file of this edition, relative to the specification's directory.
    public static func wire(_ name: String) -> String {
        "wire/\(name)-\(fileSuffix).json"
    }
}
