let overlayCount = 0;

export function setOverlayOpen(open: boolean): void {
  overlayCount = Math.max(0, overlayCount + (open ? 1 : -1));
}

export function isOverlayOpen(): boolean {
  return overlayCount > 0;
}
