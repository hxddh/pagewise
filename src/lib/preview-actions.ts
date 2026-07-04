export interface PreviewPageActions {
  prevPage: () => void;
  nextPage: () => void;
  goToPage: (page: number) => void;
}

let actions: PreviewPageActions | null = null;

export function registerPreviewActions(next: PreviewPageActions | null): void {
  actions = next;
}

export function previewPrevPage(): void {
  actions?.prevPage();
}

export function previewNextPage(): void {
  actions?.nextPage();
}

export function previewGoToPage(page: number): void {
  actions?.goToPage(page);
}
