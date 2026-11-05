import XCTest

/// Source-tree rules for the iOS app, checked on every PR (Linux and macOS).
/// They exist because generated SwiftUI drifts toward custom glass, raw
/// animation curves and system colours.
final class SourceLintTests: XCTestCase {
    private var root: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // TallylineCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // apps/ios
    }

    private func swiftFiles(under subpaths: [String]) -> [(path: String, text: String)] {
        var out: [(String, String)] = []
        for sub in subpaths {
            let dir = root.appendingPathComponent(sub)
            guard let walker = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in walker where url.pathExtension == "swift" {
                if let text = try? String(contentsOf: url, encoding: .utf8) {
                    out.append((url.path.replacingOccurrences(of: root.path + "/", with: ""), text))
                }
            }
        }
        return out
    }

    private func offenders(_ patterns: [String], allowedPathContains allowed: [String], in files: [(path: String, text: String)]) -> [String] {
        files.flatMap { file -> [String] in
            guard !allowed.contains(where: { file.path.contains($0) }) else { return [] }
            return file.text.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { index, line in
                let code = line.split(separator: "//", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
                guard patterns.contains(where: { code.contains($0) }) else { return nil }
                return "\(file.path):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))"
            }
        }
    }

    private var appFiles: [(path: String, text: String)] {
        swiftFiles(under: ["Sources/tallyline_ios", "Sources/TallylineDesign", "Extensions", "AppTarget"])
    }

    func testNoCustomGlassOutsideTheShell() {
        let bad = offenders(["glassEffect", "GlassEffectContainer", ".ultraThinMaterial", ".regularMaterial", ".thickMaterial", ".thinMaterial"], allowedPathContains: ["tallyline_ios/Shell/"], in: appFiles)
        XCTAssertEqual(bad, [], "Content stays on solid Silver Lining surfaces; glass belongs to native chrome in Shell/")
    }

    func testNoRawAnimationCurvesOutsideMotion() {
        let bad = offenders([".easeInOut", ".easeIn(", ".easeOut(", ".linear(duration", "Animation.timingCurve", ".interpolatingSpring", ".interactiveSpring"], allowedPathContains: ["Motion.swift"], in: appFiles)
        XCTAssertEqual(bad, [], "Name a MotionToken instead of writing a curve")
    }

    func testSpringsOnlyUseDurationAndBounce() {
        let bad = offenders([".spring(response", "dampingFraction"], allowedPathContains: [], in: appFiles)
        XCTAssertEqual(bad, [])
    }

    func testNoSystemColoursOrHexLiterals() {
        let bad = offenders(["Color(red:", "Color(white:", "UIColor(red:", "Color.red", "Color.blue", "Color.green", "Color.orange", "Color.yellow", "Color.pink", "Color.purple", "Color.gray", ".foregroundColor(", "Color(hex"], allowedPathContains: ["TallylineDesign/Theme.swift"], in: appFiles)
        XCTAssertEqual(bad, [], "Colours come from Theme (Silver Lining tokens)")
    }

    func testOneDeploymentFloor() throws {
        func read(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }
        XCTAssertTrue(try read("Package.swift").contains(".iOS(.v18)"))
        XCTAssertTrue(try read("project.yml").contains("iOS: \"18.0\""))
        let script = try read("scripts/xtool-testflight.sh")
        XCTAssertTrue(script.contains("\"MinimumOSVersion\": \"18.0\""))
        XCTAssertFalse(script.contains("\"MinimumOSVersion\": \"26.0\""))
    }
}
