#!/usr/bin/env swift
// macOS only; uses system frameworks, with no package dependencies.
// Run from the repository root: swift scripts/generate-brand.swift
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("docs/assets")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let ink = "#101416"
let panel = "#171D20"
let border = "#303A3E"
let paper = "#F4F0E8"
let muted = "#9AA8AD"
let coral = "#FF886B"
let mint = "#A8D8BD"

func escape(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

final class Canvas {
    let context: CGContext
    let width: Int
    let height: Int
    var elements: [String] = []

    init(width: Int, height: Int, scale: Double = 1) {
        self.width = width
        self.height = height
        context = CGContext(data: nil, width: Int(Double(width) * scale),
                            height: Int(Double(height) * scale), bitsPerComponent: 8,
                            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.translateBy(x: 0, y: Double(height) * scale)
        context.scaleBy(x: scale, y: -scale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
    }

    func color(_ hex: String) -> CGColor {
        let value = UInt32(hex.dropFirst(), radix: 16)!
        return CGColor(red: Double((value >> 16) & 255) / 255,
                       green: Double((value >> 8) & 255) / 255,
                       blue: Double(value & 255) / 255, alpha: 1)
    }

    func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double,
              radius: Double = 0, fill: String, stroke: String? = nil) {
        let path = CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h),
                          cornerWidth: radius, cornerHeight: radius, transform: nil)
        context.addPath(path)
        context.setFillColor(color(fill))
        if let stroke {
            context.setStrokeColor(color(stroke))
            context.setLineWidth(1)
            context.drawPath(using: .fillStroke)
        } else {
            context.fillPath()
        }
        elements.append("<rect x=\"\(x)\" y=\"\(y)\" width=\"\(w)\" height=\"\(h)\" rx=\"\(radius)\" fill=\"\(fill)\"\(stroke.map { " stroke=\"\($0)\"" } ?? "")/>")
    }

    func line(_ points: [(Double, Double)], color hex: String, width: Double = 2) {
        context.beginPath()
        context.move(to: CGPoint(x: points[0].0, y: points[0].1))
        for point in points.dropFirst() { context.addLine(to: CGPoint(x: point.0, y: point.1)) }
        context.setStrokeColor(color(hex))
        context.setLineWidth(width)
        context.strokePath()
        let coordinates = points.map { "\($0.0),\($0.1)" }.joined(separator: " ")
        elements.append("<polyline points=\"\(coordinates)\" fill=\"none\" stroke=\"\(hex)\" stroke-width=\"\(width)\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>")
    }

    func dot(_ x: Double, _ y: Double, radius: Double, fill: String) {
        context.setFillColor(color(fill))
        context.fillEllipse(in: CGRect(x: x - radius, y: y - radius,
                                      width: radius * 2, height: radius * 2))
        elements.append("<circle cx=\"\(x)\" cy=\"\(y)\" r=\"\(radius)\" fill=\"\(fill)\"/>")
    }

    // y is the baseline in both renderers.
    func text(_ value: String, _ x: Double, _ y: Double, size: Double,
              fill: String = paper, mono: Bool = false, bold: Bool = false) {
        let fontName = mono ? (bold ? "Menlo-Bold" : "Menlo-Regular")
                            : (bold ? "HelveticaNeue-Bold" : "HelveticaNeue")
        let font = CTFontCreateWithName(fontName as CFString, size, nil)
        let string = NSAttributedString(string: value, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(fill)
        ])
        context.saveGState()
        context.translateBy(x: x, y: y)
        context.scaleBy(x: 1, y: -1)
        context.textPosition = .zero
        CTLineDraw(CTLineCreateWithAttributedString(string), context)
        context.restoreGState()
        let family = mono ? "Menlo,Consolas,monospace" : "Helvetica Neue,Arial,sans-serif"
        elements.append("<text x=\"\(x)\" y=\"\(y)\" font-family=\"\(family)\" font-size=\"\(size)\" font-weight=\"\(bold ? 700 : 400)\" fill=\"\(fill)\">\(escape(value))</text>")
    }

    func svg(title: String, description: String) -> String {
        """
        <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" viewBox="0 0 \(width) \(height)" role="img" aria-labelledby="title description">
        <title id="title">\(escape(title))</title>
        <desc id="description">\(escape(description))</desc>
        \(elements.joined(separator: "\n"))
        </svg>

        """
    }
}

// Four terminals meet at a shared center. The same mark appears in every asset.
func mark(_ c: Canvas, x: Double, y: Double, size: Double, active: Double = 1) {
    let s = size / 100
    let centers: [(Double, Double)] = [(22, 22), (78, 22), (22, 78), (78, 78)]
    for (nx, ny) in centers {
        c.line([(x + nx * s, y + ny * s), (x + 50 * s, y + 50 * s)],
               color: border, width: 4 * s)
        let progress = active.truncatingRemainder(dividingBy: 1)
        if progress > 0 {
            c.dot(x + (nx + (50 - nx) * progress) * s,
                  y + (ny + (50 - ny) * progress) * s,
                  radius: 2.5 * s, fill: coral)
        }
        c.rect(x + (nx - 13) * s, y + (ny - 13) * s, 26 * s, 26 * s,
               radius: 6 * s, fill: panel, stroke: border)
        c.line([(x + (nx - 5) * s, y + (ny - 4) * s),
                (x + (nx - 1) * s, y + ny * s),
                (x + (nx - 5) * s, y + (ny + 4) * s)], color: paper, width: 2 * s)
        c.line([(x + (nx + 3) * s, y + (ny + 4) * s),
                (x + (nx + 7) * s, y + (ny + 4) * s)], color: coral, width: 2 * s)
    }
    c.rect(x + 41 * s, y + 41 * s, 18 * s, 18 * s, radius: 5 * s, fill: coral)
}

let commands = ["clqn init \"Our next idea\"", "clqn agent add Codex", "clqn context read conventions"]

func header(time: Double? = nil, scale: Double = 1) -> Canvas {
    let c = Canvas(width: 1280, height: 640, scale: scale)
    c.rect(0, 0, 1280, 640, radius: 24, fill: ink)
    mark(c, x: 50, y: 40, size: 72)
    c.text("clqn", 140, 100, size: 64, mono: true, bold: true)
    c.rect(1064, 58, 160, 32, radius: 16, fill: panel, stroke: border)
    c.dot(1084, 74, radius: 3, fill: mint)
    c.text("CLI + MCP", 1098, 79, size: 13, fill: muted, mono: true)

    c.text("Your agents. My agents.", 56, 210, size: 56, bold: true)
    c.text("One workspace.", 56, 282, size: 64, fill: coral, bold: true)
    mark(c, x: 1008, y: 154, size: 176, active: time.map { $0 / 1.8 } ?? 1)

    c.rect(56, 354, 1168, 220, radius: 14, fill: panel, stroke: border)
    c.dot(80, 378, radius: 4, fill: coral)
    c.dot(96, 378, radius: 4, fill: "#D8BB79")
    c.dot(112, 378, radius: 4, fill: mint)
    c.text("a shared workspace, from your terminal", 142, 383, size: 14, fill: muted, mono: true)
    c.line([(56, 400), (1224, 400)], color: border, width: 1)

    // Start on the complete poster, then type each real command and hold.
    let typing = time.map { $0 >= 1.2 && $0 < 6.3 } ?? false
    let elapsed = (time ?? 0) - 1.2
    let labels = ["WORKSPACE", "AGENT", "CONTEXT"]
    for (index, command) in commands.enumerated() {
        let y = 438.0 + Double(index) * 50
        let progress = typing ? max(0, min(1, (elapsed - Double(index) * 1.7) / 1.35)) : 1
        let count = Int(Double(command.count) * progress)
        c.text("›", 80, y, size: 24, fill: coral, mono: true)
        c.text(String(command.prefix(count)), 112, y, size: 22, mono: true)
        let current = typing && elapsed >= Double(index) * 1.7 && elapsed < Double(index + 1) * 1.7
        if current && Int((time ?? 0) * 5) % 2 == 0 {
            c.rect(112 + Double(count) * 13.25, y - 21, 11, 25, fill: coral)
        }
        c.text(labels[index], 1080, y - 2, size: 12, fill: progress >= 1 ? mint : muted, mono: true)
    }
    c.text("CLI FIRST  /  HUMAN + AGENT COLLABORATION", 56, 611, size: 12, fill: muted, mono: true)
    c.text("clqn / pronounced clan", 1032, 611, size: 12, fill: muted, mono: true)
    return c
}

func writePNG(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "brand", code: 1)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "brand", code: 2) }
}

let logo = Canvas(width: 128, height: 128)
logo.rect(0, 0, 128, 128, radius: 28, fill: ink)
mark(logo, x: 8, y: 8, size: 112)
try logo.svg(title: "clqn logo", description: "Four terminals connected to one shared workspace.")
    .write(to: output.appendingPathComponent("logo.svg"), atomically: true, encoding: .utf8)

let poster = header()
try poster.svg(title: "clqn — Your agents. My agents. One workspace.",
               description: "A CLI for humans and their own AI agents. Example commands create a clan, register an agent, and read shared context.")
    .write(to: output.appendingPathComponent("header.svg"), atomically: true, encoding: .utf8)

let frameCount = 80
let gifURL = output.appendingPathComponent("header.gif")
guard let gif = CGImageDestinationCreateWithURL(gifURL as CFURL, UTType.gif.identifier as CFString, frameCount, nil) else {
    fatalError("Could not create GIF")
}
CGImageDestinationSetProperties(gif, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for index in 0..<frameCount {
    autoreleasepool {
        let frame = header(time: Double(index) / 10, scale: 0.75)
        CGImageDestinationAddImage(gif, frame.context.makeImage()!, [
            kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]
        ] as CFDictionary)
    }
}
guard CGImageDestinationFinalize(gif) else { fatalError("Could not finalize GIF") }

// Optional previews stay outside the repository.
if let preview = ProcessInfo.processInfo.environment["CLQN_BRAND_PREVIEW_DIR"] {
    let folder = URL(fileURLWithPath: preview)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try writePNG(poster.context.makeImage()!, to: folder.appendingPathComponent("header.png"))
    try writePNG(logo.context.makeImage()!, to: folder.appendingPathComponent("logo.png"))
    for time in [1.8, 3.5, 5.2] {
        try writePNG(header(time: time).context.makeImage()!,
                     to: folder.appendingPathComponent("frame-\(time).png"))
    }
}
print("Generated docs/assets/{logo.svg,header.svg,header.gif}")
