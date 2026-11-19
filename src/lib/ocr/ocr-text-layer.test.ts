// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hasNativeTextSpans, populateOcrTextLayer } from "./ocr-text-layer";

describe("populateOcrTextLayer", () => {
  it("injects positioned selectable spans when native text layer is empty", () => {
    const container = document.createElement("div");
    const count = populateOcrTextLayer(
      container,
      [
        { text: "Riverside", bbox: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.24 } },
        { text: "Clinic", bbox: { x0: 0.32, y0: 0.2, x1: 0.48, y1: 0.24 } },
        { text: "45 days", bbox: { x0: 0.1, y0: 0.3, x1: 0.25, y1: 0.34 } },
      ],
      600,
      800,
    );
    expect(count).toBe(3);
    expect(container.getAttribute("data-main-rotation")).toBe("0");
    const spans = container.querySelectorAll<HTMLElement>("span[data-ocr-word]");
    expect(spans).toHaveLength(3);
    expect(spans[0]!.textContent).toBe("Riverside ");
    expect(spans[1]!.textContent).toBe("Clinic");
    expect(spans[0]!.style.left).toBe("60px");
    expect(spans[0]!.style.top).toBe("160px");
    expect(container.querySelectorAll("br[data-ocr-word]")).toHaveLength(1);
  });

  it("never overwrites a page that already has native pdf.js text spans", () => {
    const container = document.createElement("div");
    const native = document.createElement("span");
    native.textContent = "Native PDF words";
    container.appendChild(native);
    expect(hasNativeTextSpans(container)).toBe(true);
    const count = populateOcrTextLayer(
      container,
      [{ text: "OCR", bbox: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.15 } }],
      600,
      800,
    );
    expect(count).toBe(0);
    expect(container.querySelectorAll("[data-ocr-word]")).toHaveLength(0);
  });

  it("projects bottom-left TextItemRect OCR runs through rotated page geometry", () => {
    const container = document.createElement("div");
    const count = populateOcrTextLayer(
      container,
      [{ text: "Rotated", rect: { x: 72, y: 700, width: 80, height: 12 } }],
      792,
      612,
      {
        geometry: {
          viewportWidth: 792,
          viewportHeight: 612,
          toViewportPoint: (x, y) => [y, x],
        },
      },
    );
    expect(count).toBe(1);
    const span = container.querySelector("span[data-ocr-word]") as HTMLElement;
    expect(span.style.left).toBe("700px");
    expect(span.style.top).toBe("72px");
  });
});
