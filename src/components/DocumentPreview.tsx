import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { computeFitWidthScale, renderPageToCanvas } from "../lib/pdf";
import type { LoadedDocument } from "../lib/types";
import type { ZoomMode } from "./PreviewToolbar";
import { PreviewToolbar } from "./PreviewToolbar";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { DocumentSearch } from "./DocumentSearch";

const THUMB_COLLAPSED_KEY = "pagewise.thumbsCollapsed";
const ZOOM_KEY = "pagewise.zoom";

function loadZoom(): ZoomMode {
  const raw = localStorage.getItem(ZOOM_KEY);
  if (raw === "fit-width") return "fit-width";
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : "fit-width";
}

interface DocumentPreviewProps {
  doc: LoadedDocument | null;
  page: number;
  onPageChange: (page: number) => void;
}

export function DocumentPreview({ doc, page, onPageChange }: DocumentPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const [thumbsCollapsed, setThumbsCollapsed] = useState(
    () => localStorage.getItem(THUMB_COLLAPSED_KEY) === "1",
  );

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, zoom === "fit-width" ? "fit-width" : String(zoom));
  }, [zoom]);

  useEffect(() => {
    localStorage.setItem(THUMB_COLLAPSED_KEY, thumbsCollapsed ? "1" : "0");
  }, [thumbsCollapsed]);

  useEffect(() => {
    if (!doc || doc.kind !== "pdf" || !canvasRef.current) return;

    let cancelled = false;
    setRendering(true);
    setRenderError(null);

    (async () => {
      try {
        let scale: number;
        if (zoom === "fit-width") {
          const width = wrapRef.current?.clientWidth ?? 800;
          scale = await computeFitWidthScale(doc.path, page, width);
        } else {
          scale = zoom;
        }
        if (cancelled || !canvasRef.current) return;
        await renderPageToCanvas(doc.path, page, canvasRef.current, scale);
      } catch (e) {
        if (!cancelled) {
          setRenderError(e instanceof Error ? e.message : "Failed to render page");
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, page, zoom]);

  if (!doc) {
    return (
      <div className="preview-panel preview-empty">
        <div className="preview-placeholder">
          <p className="preview-title">No document</p>
          <p className="preview-hint">
            Open a file or drag &amp; drop a PDF / image here
          </p>
        </div>
      </div>
    );
  }

  if (doc.kind === "image") {
    return (
      <div className="preview-panel">
        <header className="preview-toolbar image-toolbar">
          <span className="preview-filename" title={doc.name}>
            {doc.name}
          </span>
          <DocumentSearch doc={doc} onJumpToPage={onPageChange} />
        </header>
        <div className="preview-canvas-wrap image-wrap" ref={wrapRef}>
          <img src={convertFileSrc(doc.path)} alt={doc.name} className="preview-image" />
        </div>
      </div>
    );
  }

  return (
    <div className="preview-panel preview-with-thumbs">
      <ThumbnailSidebar
        path={doc.path}
        totalPages={doc.totalPages}
        currentPage={page}
        collapsed={thumbsCollapsed}
        onToggle={() => setThumbsCollapsed((c) => !c)}
        onPageSelect={onPageChange}
      />

      <div className="preview-main">
        <PreviewToolbar
          filename={doc.name}
          page={page}
          totalPages={doc.totalPages}
          zoom={zoom}
          onZoomChange={setZoom}
          onPageChange={onPageChange}
          searchSlot={<DocumentSearch doc={doc} onJumpToPage={onPageChange} />}
        />

        <div className="preview-canvas-wrap" ref={wrapRef}>
          {rendering && <div className="preview-loading">Rendering…</div>}
          {renderError && <p className="error-line">{renderError}</p>}
          <canvas ref={canvasRef} className="preview-canvas" />
        </div>
      </div>
    </div>
  );
}
