// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k, locale: "en", localeMode: "en", setLocaleMode: () => {} }) }));

import { registerPreviewActions } from "../lib/preview-actions";
import { useAppCommands } from "./useAppCommands";

afterEach(() => {
  cleanup();
  registerPreviewActions(null);
});

const noop = () => {};
function mount(activeDocName: string | null) {
  return renderHook(() =>
    useAppCommands({
      activeDocName,
      hasMarks: false,
      messages: [],
      busy: false,
      followAgent: false,
      agentOpen: true,
      previewPage: 2,
      totalPages: 5,
      onOpenDocument: noop,
      onOpenSettings: noop,
      onToggleFollowAgent: noop,
      onToggleAgent: noop,
      onClearChat: noop,
      onStop: noop,
      onCycleTheme: noop,
      onExportChat: noop,
      onExportDocument: noop,
      onExportMarks: noop,
      onScanAllPages: noop,
      canScanAllPages: false,
      showToast: noop,
    }),
  );
}

const press = (key: string, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));

describe("B18: ⌘[ and ⌘] turn the page (16.0)", () => {
  it("turns back and forward with a document open", () => {
    const prevPage = vi.fn();
    const nextPage = vi.fn();
    registerPreviewActions({ prevPage, nextPage, goToPage: noop });
    mount("doc.pdf");
    press("[");
    press("]");
    expect(prevPage).toHaveBeenCalledTimes(1);
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("does nothing while typing, or with no document", () => {
    const nextPage = vi.fn();
    registerPreviewActions({ prevPage: noop, nextPage, goToPage: noop });
    mount("doc.pdf");
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    press("]", input);
    input.remove();
    cleanup();
    mount(null);
    press("]");
    expect(nextPage).not.toHaveBeenCalled();
  });
});
