// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { ExportDialog } from "./ExportDialog";

afterEach(cleanup);

describe("one way out (16.0)", () => {
  it("offers three exports, saying why one is unavailable", () => {
    render(
      <ExportDialog open available={{ report: false, pdf: true, chat: true }} busy={false} onExport={() => {}} onClose={() => {}} />,
    );
    const options = screen.getAllByRole("button").filter((b) => b.classList.contains("export-option"));
    expect(options).toHaveLength(3);
    expect(options[0]!.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("export.reportEmpty")).toBeTruthy();
  });

  it("B17: the report is there when the conversation is empty", () => {
    const onExport = vi.fn();
    render(<ExportDialog open available={{ report: true, pdf: false, chat: false }} busy={false} onExport={onExport} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("export.includeText"));
    fireEvent.click(screen.getByText("export.report"));
    expect(onExport).toHaveBeenCalledWith("report", { includeText: true });
  });

  it("holds the conversation back while an answer streams", () => {
    render(<ExportDialog open available={{ report: true, pdf: true, chat: true }} busy onExport={() => {}} onClose={() => {}} />);
    expect(screen.getByText("export.busy")).toBeTruthy();
  });
});
