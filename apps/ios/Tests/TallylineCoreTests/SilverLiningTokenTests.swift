import XCTest
@testable import TallylineCore

final class SilverLiningTokenTests: XCTestCase {
    func testParsesHex() {
        XCTAssertEqual(SilverLiningRGBA.parse("#ff0000"), SilverLiningRGBA(red: 1, green: 0, blue: 0))
        XCTAssertEqual(SilverLiningRGBA.parse("#0f0"), SilverLiningRGBA(red: 0, green: 1, blue: 0))
        XCTAssertEqual(SilverLiningRGBA.parse("#00000000")?.alpha, 0)
    }

    func testParsesRgba() {
        let c = SilverLiningRGBA.parse("rgba(51,159,238,0.14)")
        XCTAssertEqual(c?.red ?? 0, 51.0 / 255, accuracy: 1e-9)
        XCTAssertEqual(c?.alpha ?? 0, 0.14, accuracy: 1e-9)
        XCTAssertEqual(SilverLiningRGBA.parse("rgb(0, 0, 255)")?.blue, 1)
    }

    func testRejectsGarbage() {
        XCTAssertNil(SilverLiningRGBA.parse("oklch(0.5 0.1 200)"))
        XCTAssertNil(SilverLiningRGBA.parse("#12345"))
        XCTAssertNil(SilverLiningRGBA.parse("rgba(300,0,0,1)"))
        XCTAssertNil(SilverLiningRGBA.parse("rgba(0,0,0,2)"))
    }

    func testEveryTokenParsesInEveryTheme() {
        XCTAssertEqual(SilverLiningTokens.tokenNames.count, 32)
        for palette in [SilverLiningTokens.dark, SilverLiningTokens.light, SilverLiningTokens.hcDark] {
            for name in SilverLiningTokens.tokenNames {
                let raw = SilverLiningTokens.value(name, in: palette)
                XCTAssertNotNil(raw, name)
                XCTAssertNotNil(SilverLiningRGBA.parse(raw ?? ""), "\(name) = \(raw ?? "nil")")
            }
        }
    }

    func testPaletteSelection() {
        XCTAssertEqual(SilverLiningAppearance.palette(isDark: false, highContrast: true), SilverLiningTokens.light)
        XCTAssertEqual(SilverLiningAppearance.palette(isDark: true, highContrast: false), SilverLiningTokens.dark)
        XCTAssertEqual(SilverLiningAppearance.palette(isDark: true, highContrast: true), SilverLiningTokens.hcDark)
    }
}
