import { describe, expect, it } from "vitest";
import { visionRenderScale } from "./pdf";

// paintPage multiplies the scale it receives by getOutputScale(), so the encoded
// pixel long-edge is `edge * visionRenderScale(edge, maxEdge, outputScale) * outputScale`.
const encodedEdge = (edge: number, maxEdge: number, outputScale: number) =>
  edge * visionRenderScale(edge, maxEdge, outputScale) * outputScale;

const OCR_RENDER_SCALE = 300 / 72;

describe("visionRenderScale", () => {
  it("caps the encoded long edge at maxEdge for a large page (letter, 792pt)", () => {
    expect(encodedEdge(792, 1568, 1)).toBeCloseTo(1568, 3);
  });

  it("is device-pixel-ratio independent: retina encodes the same pixels, not 2x (N1 regression)", () => {
    const nonRetina = encodedEdge(792, 1568, 1);
    const retina = encodedEdge(792, 1568, 2);
    expect(retina).toBeCloseTo(nonRetina, 3);
    // Before the fix, paintPage's outputScale=2 doubled this to ~3136px.
    expect(retina).toBeCloseTo(1568, 3);
    // The scale handed to paintPage is halved on retina to compensate.
    expect(visionRenderScale(792, 1568, 2)).toBeCloseTo(
      visionRenderScale(792, 1568, 1) / 2,
      6,
    );
  });

  it("never exceeds maxEdge across DPR values", () => {
    for (const outputScale of [1, 1.5, 2]) {
      expect(encodedEdge(792, 1568, outputScale)).toBeLessThanOrEqual(1568 + 1e-6);
    }
  });

  it("uses OCR_RENDER_SCALE when the page is smaller than maxEdge allows", () => {
    // A 200pt page is small enough that the 300-DPI target binds, not maxEdge.
    expect(encodedEdge(200, 1568, 1)).toBeCloseTo(200 * OCR_RENDER_SCALE, 3);
    expect(encodedEdge(200, 1568, 2)).toBeCloseTo(200 * OCR_RENDER_SCALE, 3);
  });

  it("falls back to the target scale when outputScale is non-positive", () => {
    expect(visionRenderScale(792, 1568, 0)).toBeCloseTo(1568 / 792, 6);
  });
});
