export interface ImeKeyLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number } | null;
}

/**
 * True while an IME composition (e.g. Pinyin, Kana, Hangul) is active.
 *
 * macOS WKWebView dispatches `keyCode === 229` or `isComposing === true` on
 * `Enter` (confirming ASCII/candidates) and `Escape` (dismissing the candidate
 * popup). Handlers that submit forms or close modals on Enter/Escape must step
 * aside while composition is in flight.
 */
export function isImeComposing(event: ImeKeyLike | null | undefined): boolean {
  if (!event) return false;
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}
