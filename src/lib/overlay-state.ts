// Global overlay-open tracking. Used by shortcut guards to decide whether global
// shortcuts should be suppressed while any overlay (modal, palette, sheet) is open.
//
// We track a Set of owner tokens rather than a bare counter so that an abnormally
// unmounted component can't leave the counter permanently >0 and disable shortcuts
// forever: even if a token is never released, replacing the owner (or clearing) is
// deterministic, and each open owns exactly one identifiable slot.

let nextOwnerToken = 1;
const openOwners = new Set<number>();

/** Register an open overlay. Returns a token to pass back to closeOverlay(). */
export function openOverlay(): number {
  const token = nextOwnerToken++;
  openOwners.add(token);
  return token;
}

/** Release a previously opened overlay by its token. */
export function closeOverlay(token: number): void {
  openOwners.delete(token);
}

export function isOverlayOpen(): boolean {
  return openOwners.size > 0;
}

// Backward-compatible boolean API used by existing hooks (useOverlayLock). Each
// open/close pair is matched via a private token stack so it shares the same
// tracking Set as the token API above.
const legacyTokens: number[] = [];
export function setOverlayOpen(open: boolean): void {
  if (open) {
    legacyTokens.push(openOverlay());
  } else {
    const token = legacyTokens.pop();
    if (token !== undefined) closeOverlay(token);
  }
}

// --- Escape-layer stack -----------------------------------------------------
// Stacked overlays register a layer so only the topmost one handles the Escape
// key. Each push returns a unique id; the overlay checks isTopOverlayLayer(id)
// before acting on Escape and pops on unmount.

let nextLayerId = 1;
const overlayLayerStack: number[] = [];

/** Push a new escape layer and return its unique id. */
export function pushOverlayLayer(): number {
  const id = nextLayerId++;
  overlayLayerStack.push(id);
  return id;
}

/** Remove the given escape layer from the stack (safe if not present). */
export function popOverlayLayer(id: number): void {
  const idx = overlayLayerStack.lastIndexOf(id);
  if (idx !== -1) overlayLayerStack.splice(idx, 1);
}

/** True when the given layer id is the topmost (Escape-owning) layer. */
export function isTopOverlayLayer(id: number): boolean {
  return overlayLayerStack.length > 0 && overlayLayerStack[overlayLayerStack.length - 1] === id;
}
