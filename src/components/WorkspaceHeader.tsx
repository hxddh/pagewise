import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  LayoutGrid,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  SquareDashedMousePointer,
} from "lucide-react";
import { useI18n } from "../i18n";
import { AnchoredMenu } from "./AnchoredMenu";
import { Button } from "./ui/Button";
import { IconChevronLeft, IconChevronRight } from "./Icon";
import { Input } from "./ui/Field";
import { ListRow } from "./ui/ListRow";
import { Tabs } from "./ui/Tabs";
import { labelForPage, pageForLabel } from "../lib/page-labels";
import { isSameZoom, ZOOM_PRESETS, type ZoomMode } from "../lib/zoom";
import { requestOpenDocSearch } from "../lib/events";
import { modKey } from "../lib/shortcut-display";
import { subscribeWriteHealth, unsavedWrites } from "../lib/store-health";

/**
 * The workspace's one header strip.
 *
 * Until 19.0 there were two strips at the same height: the document toolbar
 * (filename, page controls, thumbnails, region mode, zoom) and the assistant
 * panel's header (tabs, collapse, overflow) — nine controls between them.
 * They are one strip now: file name, page position, the panel's tabs, and one
 * overflow menu; everything else moved into the overflow or stayed a shortcut
 * (⌘F, ⌘+, ⌘-, ⌘\, ⌘[, ⌘]).
 *
 * It is rendered by the preview pane's toolbar component, which still receives
 * the zoom/thumbnail/region state from the viewer; where it draws — a slot
 * above both columns — arrives through the context below.
 */
export interface WorkspaceChrome {
  /** Where the strip renders: the workspace's own header slot. */
  slot: HTMLElement | null;
  /** Which half of the assistant column is showing, and its badge count. */
  panelTab: "chat" | "record";
  setPanelTab: (tab: "chat" | "record") => void;
  recordCount: number;
  agentOpen: boolean;
  /** The conversation has something in it, and a run is not going: the two
   *  conditions Clear chat stands down under. */
  hasMessages: boolean;
  busy: boolean;
  /** Pages with no text yet; the overflow offers to read them. */
  canScanAll: boolean;
  onScanAll?: () => void;
  onOpenExport: () => void;
  onClearChat: () => void;
  onToggleAgent: () => void;
}

const WorkspaceChromeContext = createContext<WorkspaceChrome | null>(null);

export function WorkspaceChromeProvider({
  value,
  children,
}: {
  value: WorkspaceChrome;
  children: ReactNode;
}) {
  return <WorkspaceChromeContext.Provider value={value}>{children}</WorkspaceChromeContext.Provider>;
}

export function useWorkspaceChrome(): WorkspaceChrome | null {
  return useContext(WorkspaceChromeContext);
}

export interface WorkspaceHeaderProps {
  filename: string;
  page: number;
  totalPages: number;
  /** What the pages call themselves, when that differs from where they sit. */
  pageLabels?: string[];
  zoom: ZoomMode;
  onZoomChange: (zoom: ZoomMode) => void;
  /** Accepted from the preview pane; zoom in/out stay keyboard shortcuts. */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  zoomDisabled?: boolean;
  onPageChange: (page: number) => void;
  thumbsVisible: boolean;
  onToggleThumbs: () => void;
  /** Region-marking mode. Absent on documents that cannot be marked. */
  regionMode?: boolean;
  onToggleRegionMode?: () => void;
}

function PageNav({
  page,
  totalPages,
  pageLabels,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  pageLabels?: string[];
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  // What is printed on this page, when it is not simply the page's position.
  const printed = labelForPage(pageLabels ?? null, page);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(page));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // A one-page document has nowhere to go, but the strip keeps its centre:
  // returning nothing let the file name and the tabs slide into the middle,
  // so the header's balance changed with the document (21.0). Not a control.
  if (totalPages <= 1) return <div className="toolbar-group toolbar-group-page" aria-hidden="true" />;

  function commit() {
    // A printed number first, when the document prints any: a reader looking
    // at a footer that says 47 means that page, not the 47th sheet. Falls
    // through when the number is not printed, or is printed twice.
    const byLabel = pageForLabel(pageLabels ?? null, draft);
    if (byLabel !== null) {
      onPageChange(byLabel);
      setDraft(String(byLabel));
      setEditing(false);
      return;
    }
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(page));
      setEditing(false);
      return;
    }
    const clamped = Math.min(totalPages, Math.max(1, n));
    onPageChange(clamped);
    setDraft(String(clamped));
    setEditing(false);
  }

  return (
    <div className="toolbar-group toolbar-group-page">
      <Button
        variant="ghost"
        size="md"
        className="toolbar-btn"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        title={t("preview.previousPageHint")}
        aria-label={t("preview.previousPage")}
      >
        <IconChevronLeft size={14} />
      </Button>
      {editing ? (
        <Input
          ref={inputRef}
          size="sm"
          numeric
          className="toolbar-page-input"
          value={draft}
          // Digits only where pages are numbered with digits; a document that
          // prints "iv" or "A-1" needs those characters to reach `commit`.
          onChange={(e) =>
            setDraft(
              pageLabels ? e.target.value.slice(0, 24) : e.target.value.replace(/\D/g, ""),
            )
          }
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setDraft(String(page));
              setEditing(false);
            }
          }}
          aria-label={t("preview.pageOf", { page, total: totalPages })}
        />
      ) : (
        <Button
          variant="ghost"
          size="md"
          className="toolbar-btn toolbar-page-label"
          onClick={() => setEditing(true)}
          title={t("preview.pageOf", { page, total: totalPages })}
          aria-label={t("preview.pageOf", { page, total: totalPages })}
        >
          {/* The printed number leads; the position follows, quieter. Shown
              only where the two disagree. */}
          {printed ? <span className="toolbar-page-printed">{printed}</span> : null}
          <span className="toolbar-page-current">{page}</span>
          <span className="toolbar-page-sep">/</span>
          <span className="toolbar-page-total">{totalPages}</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="md"
        className="toolbar-btn"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        title={t("preview.nextPageHint")}
        aria-label={t("preview.nextPage")}
      >
        <IconChevronRight size={14} />
      </Button>
    </div>
  );
}

/**
 * "Not saved", beside the file name, while a write of the conversation, the
 * marks or the record keeps failing (24.0). The toast says it once and goes;
 * this stays until a write of that kind lands, so a reader who missed the toast
 * still sees that what is on screen is not on disk. Status, not a control.
 */
function NotSaved() {
  const { t } = useI18n();
  const unsaved = useSyncExternalStore(subscribeWriteHealth, unsavedWrites);
  if (unsaved.length === 0) return null;
  return (
    <span
      className="preview-not-saved"
      role="status"
      title={unsaved.map((kind) => t(`toast.writeFailed.${kind}`)).join("\n")}
    >
      {t("preview.notSaved")}
    </span>
  );
}

export function WorkspaceHeader({
  filename,
  page,
  totalPages,
  pageLabels,
  zoom,
  onZoomChange,
  zoomDisabled,
  onPageChange,
  thumbsVisible,
  onToggleThumbs,
  regionMode,
  onToggleRegionMode,
}: WorkspaceHeaderProps) {
  const { t } = useI18n();
  const chrome = useWorkspaceChrome();
  const [menuOpen, setMenuOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const mod = modKey();

  const basename = filename.includes("/")
    ? filename.slice(filename.lastIndexOf("/") + 1)
    : filename;
  const close = () => setMenuOpen(false);
  /** A menu row's handler: dismiss the menu, then do the thing. */
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <header className="preview-toolbar preview-toolbar-slim">
      <div className="toolbar-left">
        <span className="preview-filename" title={filename}>
          {basename}
        </span>
        <NotSaved />
      </div>

      <div className="preview-toolbar-center">
        <PageNav
          page={page}
          totalPages={totalPages}
          pageLabels={pageLabels}
          onPageChange={onPageChange}
        />
      </div>

      <div className="toolbar-right">
        {chrome?.agentOpen && (
          <Tabs
            className="panel-tabs"
            items={[
              { id: "chat", label: t("record.tabChat") },
              {
                id: "record",
                label: t("record.tabRecord"),
                badge:
                  chrome.recordCount > 0 ? (
                    <span className="panel-tab-count">{chrome.recordCount}</span>
                  ) : undefined,
              },
            ]}
            value={chrome.panelTab}
            onChange={chrome.setPanelTab}
          />
        )}
        <div className="header-actions">
          <Button
            ref={moreBtnRef}
            variant="ghost" size="md" icon
            aria-pressed={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={t("agent.more")}
            title={t("agent.more")}
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={16} />
          </Button>
          <AnchoredMenu
            open={menuOpen}
            onClose={close}
            anchorRef={moreBtnRef}
            className="anchored-popover"
          >
            <ListRow
              role="menuitem"
              label={t("commands.searchDoc")}
              trailing={mod + "F"}
              onClick={run(requestOpenDocSearch)}
            />
            {totalPages > 1 && (
              <ListRow
                role="menuitem"
                leading={<LayoutGrid size={14} aria-hidden />}
                label={thumbsVisible ? t("preview.thumbnailsHide") : t("preview.thumbnailsShow")}
                onClick={run(onToggleThumbs)}
              />
            )}
            {onToggleRegionMode && (
              <ListRow
                role="menuitem"
                leading={<SquareDashedMousePointer size={14} aria-hidden />}
                label={t("marks.regionMode")}
                active={!!regionMode}
                onClick={run(onToggleRegionMode)}
              />
            )}
            <div className="zoom-menu-divider" role="separator" />
            {ZOOM_PRESETS.map((z) => (
              <ListRow
                key={z.labelKey}
                role="menuitemradio"
                aria-checked={isSameZoom(zoom, z.value)}
                className="zoom-menu-item"
                active={isSameZoom(zoom, z.value)}
                disabled={zoomDisabled}
                label={t(z.labelKey)}
                onClick={run(() => onZoomChange(z.value))}
              />
            ))}
            {chrome && (
              <>
                <div className="zoom-menu-divider" role="separator" />
                <ListRow
                  role="menuitem"
                  label={t("agent.export")}
                  onClick={run(chrome.onOpenExport)}
                />
                {chrome.onScanAll && chrome.canScanAll && (
                  <ListRow
                    role="menuitem"
                    label={t("preview.scanAllAction")}
                    onClick={run(chrome.onScanAll)}
                  />
                )}
                <div className="zoom-menu-divider" role="separator" />
                <ListRow
                  role="menuitem"
                  leading={
                    chrome.agentOpen ? (
                      <PanelRightClose size={14} aria-hidden />
                    ) : (
                      <PanelRightOpen size={14} aria-hidden />
                    )
                  }
                  label={chrome.agentOpen ? t("agent.hidePanel") : t("agent.showPanel")}
                  onClick={run(chrome.onToggleAgent)}
                />
                <ListRow
                  role="menuitem"
                  className="danger"
                  label={t("agent.clear")}
                  onClick={run(chrome.onClearChat)}
                  disabled={chrome.busy || !chrome.hasMessages}
                />
              </>
            )}
          </AnchoredMenu>
        </div>
      </div>
    </header>
  );
}
