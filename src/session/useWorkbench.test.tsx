// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedDocument } from "../lib/types";
import type { PageWiseUIMessage } from "../lib/message-metadata";

const loadDocumentMock = vi.fn();
const commitLoadedDocumentMock = vi.fn((staged: LoadedDocument) => staged);
const loadChatMock = vi.fn();
const saveChatMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    destroy: async () => undefined,
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("../lib/load-document", () => ({
  loadDocument: (...args: unknown[]) => loadDocumentMock(...args),
  commitLoadedDocument: (staged: LoadedDocument) => commitLoadedDocumentMock(staged),
}));
vi.mock("../lib/doc-cache", () => ({
  docCache: {
    get: () => undefined,
    subscribe: () => () => undefined,
  },
}));
vi.mock("../lib/mark-store", () => ({
  flushMarks: vi.fn(async () => undefined),
  getMarks: () => [],
  loadMarks: vi.fn(async () => []),
  subscribeMarks: () => () => undefined,
}));
vi.mock("../lib/finding-store", () => ({
  flushFindings: vi.fn(async () => undefined),
  loadFindings: vi.fn(async () => []),
  subscribeFindings: () => () => undefined,
}));
vi.mock("../lib/index-store", () => ({ flushIndexStore: vi.fn(async () => undefined) }));
vi.mock("../lib/ocr/ocr-service", () => ({ flushOcrService: vi.fn(async () => undefined) }));
vi.mock("../lib/citation-check", () => ({ checkCitation: vi.fn() }));
vi.mock("../lib/claim-review", () => ({ loadReviews: vi.fn(async () => undefined) }));
vi.mock("../lib/finding-anchors", () => ({
  clearFindingAnchors: vi.fn(),
  prewarmPlacements: vi.fn(async () => undefined),
}));
vi.mock("../lib/agent-record-context", () => ({ trustedFindings: () => [] }));
vi.mock("../lib/recent-files", () => ({
  addRecentFile: vi.fn(async () => []),
  getRecentFiles: vi.fn(async () => []),
  reconcileRecentFiles: vi.fn(async () => []),
  removeRecentFile: vi.fn(async () => []),
  updateRecentProgress: vi.fn(async () => []),
}));
vi.mock("../lib/allowed-paths", () => ({
  checkRecentPaths: vi.fn(async () => []),
  openSampleDocument: vi.fn(async () => "/sample.pdf"),
  pickDocument: vi.fn(async () => null),
}));
vi.mock("../lib/invoke-cmd", () => ({ invokeCmd: vi.fn(async () => undefined) }));
vi.mock("../lib/pdf", () => ({ clearPdfCache: vi.fn() }));
vi.mock("../document/index-queue", () => ({ reindexDocument: vi.fn() }));
vi.mock("../chat/persist", () => ({
  clearChat: vi.fn(async () => undefined),
  loadChat: (...args: unknown[]) => loadChatMock(...args),
  pruneOrphanedChats: vi.fn(async () => undefined),
  saveChat: (...args: unknown[]) => saveChatMock(...args),
}));
vi.mock("../lib/document-scope", () => ({
  createDocumentScope: () => ({ dispose: vi.fn() }),
}));
vi.mock("../hooks/useDocAgent", async () => {
  const React = await import("react");
  return {
    warmDocAgentInIdle: vi.fn(),
    useDocAgent: (chatId: string) => {
      const [list, setList] = React.useState<PageWiseUIMessage[]>([]);
      return {
        messages: {
          list,
          set: setList,
          clear: () => setList([]),
        },
        run: {
          status: "ready" as const,
          error: undefined,
          errorMessage: undefined,
          progress: null,
          isBusy: () => false,
          send: async () => true,
          edit: async () => true,
          regenerate: async () => true,
          stop: () => undefined,
          steer: () => false,
          waitForIdle: async () => true,
          clearError: () => undefined,
          reset: () => setList([]),
          abort: () => undefined,
        },
        history: {
          settling: false,
          chatId,
        },
      };
    },
  };
});
vi.mock("../hooks/useConnectionStatus", () => ({
  useConnectionStatus: () => ({ state: "ready", label: "m", provider: "deepseek", refresh: vi.fn() }),
}));
vi.mock("../hooks/useResizeWidth", () => ({
  useResizeWidth: () => ({ width: 420, dragging: false, startResize: vi.fn() }),
}));
vi.mock("../hooks/useTauriFileDrop", () => ({ useTauriFileDrop: () => false }));
vi.mock("../hooks/useOpenPathEvent", () => ({ useOpenPathEvent: () => undefined }));
vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));
vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import { useWorkbench, type Workbench } from "./useWorkbench";

function makeDoc(path: string, name: string): LoadedDocument {
  return {
    path,
    name,
    kind: "pdf",
    totalPages: 4,
    pages: [],
    stamp: `stamp-${name}`,
    identity: `fnv1a64:0000000000000001:100`,
    outline: [],
    links: [],
    figures: [],
  };
}

describe("useWorkbench document switch recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores phase, chatLoading, and current chat when a queued open re-targets the already-open document", async () => {
    const docA = makeDoc("/a.pdf", "a.pdf");
    const historyA: PageWiseUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "First question" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "First answer" }] },
    ];

    let startedB: (() => void) | null = null;
    const bStartedPromise = new Promise<void>((resolve) => {
      startedB = resolve;
    });

    loadDocumentMock.mockImplementation(
      (path: string, _onProgress: unknown, signal?: AbortSignal) => {
        if (path === "/a.pdf") return Promise.resolve(docA);
        return new Promise<LoadedDocument>((_resolve, reject) => {
          startedB?.();
          signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      },
    );
    loadChatMock.mockImplementation(async (path: string) => (path === "/a.pdf" ? historyA : []));

    let wb!: Workbench;
    function Probe() {
      wb = useWorkbench();
      return <>{wb.agentHost}</>;
    }

    render(<Probe />);

    await act(async () => {
      wb.library.openPath("/a.pdf");
    });

    await waitFor(() => {
      expect(wb.document.phase).toBe("ready");
      expect(wb.document.chatLoading).toBe(false);
      expect(wb.document.doc?.path).toBe("/a.pdf");
      expect(wb.assistant.agent.messages.list).toHaveLength(2);
    });

    // Start opening B, then while B is mid-flight, request A again (e.g. file drop / OS open).
    act(() => {
      wb.library.openPath("/b.pdf");
    });
    await bStartedPromise;
    expect(wb.document.phase).toBe("switching");
    expect(wb.document.chatLoading).toBe(true);

    await act(async () => {
      wb.library.openPath("/a.pdf");
    });

    await waitFor(() => {
      expect(wb.document.phase).toBe("ready");
      expect(wb.document.chatLoading).toBe(false);
      expect(wb.document.doc?.path).toBe("/a.pdf");
      expect(wb.assistant.agent.messages.list.map((m) => m.id)).toEqual(["u1", "a1"]);
    });
  });
});
