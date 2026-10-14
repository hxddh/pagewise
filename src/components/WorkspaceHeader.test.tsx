// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

const { WorkspaceHeader, WorkspaceChromeProvider } = await import("./WorkspaceHeader");

function setup(chromeOverrides: Record<string, unknown> = {}) {
  const chrome = {
    slot: null,
    panelTab: "chat" as const,
    setPanelTab: vi.fn(),
    recordCount: 0,
    agentOpen: true,
    hasMessages: true,
    busy: false,
    canScanAll: false,
    onOpenExport: vi.fn(),
    onClearChat: vi.fn(),
    onToggleAgent: vi.fn(),
    ...chromeOverrides,
  };
  const props = {
    filename: "/docs/report.pdf",
    page: 12,
    totalPages: 120,
    zoom: { kind: "fit-width" as const },
    onZoomChange: vi.fn(),
    onPageChange: vi.fn(),
    thumbsVisible: false,
    onToggleThumbs: vi.fn(),
  };
  const view = render(
    <WorkspaceChromeProvider value={chrome}>
      <WorkspaceHeader {...(props as unknown as Parameters<typeof WorkspaceHeader>[0])} />
    </WorkspaceChromeProvider>,
  );
  const openMenu = () => fireEvent.click(view.getByLabelText("agent.more"));
  return { view, chrome, props, openMenu };
}

afterEach(cleanup);

describe("WorkspaceHeader", () => {
  it("is one strip: file name, page position, the panel's tabs, one overflow", () => {
    const { view } = setup();
    // Four persistent controls, the number the 19.0 review asks to be ≤6.
    expect(view.getByText("report.pdf")).toBeTruthy();
    expect(view.getByText("12")).toBeTruthy();
    expect(view.getByRole("tab", { name: "record.tabChat" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "record.tabRecord" })).toBeTruthy();
    expect(view.getByLabelText("agent.more")).toBeTruthy();
    // Nothing from the old two strips is still in the open: no zoom label, no
    // thumbnails or region buttons, no collapse button.
    expect(view.queryByLabelText("preview.zoom")).toBeNull();
    expect(view.queryByLabelText("preview.thumbnailsShow")).toBeNull();
    expect(view.queryByLabelText("marks.regionMode")).toBeNull();
    expect(view.queryByLabelText("agent.hidePanel")).toBeNull();
  });

  it("switches the panel's half through the tabs", () => {
    const { view, chrome } = setup();
    fireEvent.click(view.getByRole("tab", { name: "record.tabRecord" }));
    expect(chrome.setPanelTab).toHaveBeenCalledWith("record");
  });

  it("hides the tabs while the panel is closed", () => {
    const { view } = setup({ agentOpen: false });
    expect(view.queryByRole("tab", { name: "record.tabChat" })).toBeNull();
  });

  it("keeps the moved controls reachable in the overflow", () => {
    const { view, chrome, props, openMenu } = setup({ canScanAll: true, onScanAll: vi.fn() });
    openMenu();

    // Thumbnails/outline, document search, zoom presets, export, scan-all and
    // the panel toggle all live here now.
    expect(view.getByText("preview.thumbnailsShow")).toBeTruthy();
    // The search row carries its shortcut beside the label.
    expect(view.getByRole("menuitem", { name: /commands\.searchDoc/ })).toBeTruthy();
    expect(view.getByText("preview.fitWidth")).toBeTruthy();
    expect(view.getByText("agent.export")).toBeTruthy();
    expect(view.getByText("preview.scanAllAction")).toBeTruthy();
    expect(view.getByText("agent.hidePanel")).toBeTruthy();
    expect(view.getByText("agent.clear")).toBeTruthy();
    // The follow toggle is not here: since 19.0 its one home is the Reading
    // group in Settings, where the preference belongs.
    expect(view.queryByText("commands.enableFollow")).toBeNull();
    expect(view.queryByText("commands.disableFollow")).toBeNull();

    fireEvent.click(view.getByText("preview.thumbnailsShow"));
    expect(props.onToggleThumbs).toHaveBeenCalled();
    openMenu();
    fireEvent.click(view.getByText("agent.export"));
    expect(chrome.onOpenExport).toHaveBeenCalled();
    openMenu();
    fireEvent.click(view.getByText("agent.hidePanel"));
    expect(chrome.onToggleAgent).toHaveBeenCalled();
  });

  it("turns the page from the position control", () => {
    const { view, props } = setup();
    fireEvent.click(view.getByLabelText("preview.nextPage"));
    expect(props.onPageChange).toHaveBeenCalledWith(13);
    fireEvent.click(view.getByLabelText("preview.previousPage"));
    expect(props.onPageChange).toHaveBeenCalledWith(11);
  });

  it("draws into the app's slot: one strip across both columns", async () => {
    const { PreviewToolbar } = await import("./PreviewToolbar");
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const chrome = {
      slot,
      panelTab: "chat" as const,
      setPanelTab: vi.fn(),
      recordCount: 0,
      agentOpen: true,
      hasMessages: true,
      busy: false,
      canScanAll: false,
      onOpenExport: vi.fn(),
      onClearChat: vi.fn(),
      onToggleAgent: vi.fn(),
      followAgent: false,
      onToggleFollow: vi.fn(),
    };
    render(
      <WorkspaceChromeProvider value={chrome}>
        <PreviewToolbar
          {...({
            filename: "a.pdf",
            page: 1,
            totalPages: 2,
            zoom: "fit-width",
            onZoomChange: vi.fn(),
            onPageChange: vi.fn(),
            thumbsVisible: false,
            onToggleThumbs: vi.fn(),
          } as Parameters<typeof PreviewToolbar>[0])}
        />
      </WorkspaceChromeProvider>,
    );
    // The strip is a child of the slot the app owns, not of the pane that
    // rendered the toolbar component.
    expect(slot.querySelector(".preview-toolbar")).toBeTruthy();
    expect(slot.textContent).toContain("a.pdf");
    slot.remove();
  });
});
