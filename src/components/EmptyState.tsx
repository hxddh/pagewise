const EXAMPLE_PROMPTS = [
  "Summarize the first page",
  "What dates are mentioned?",
  "List the main parties or entities",
  "What are the key obligations?",
];

interface EmptyStateProps {
  hasApiKey: boolean;
  hasDocument: boolean;
  onOpenSettings: () => void;
  onOpenFile: () => void;
  onSendExample: (text: string) => void;
}

export function EmptyState({
  hasApiKey,
  hasDocument,
  onOpenSettings,
  onOpenFile,
  onSendExample,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-lead">Ask questions about your document</p>
      <ol className="empty-steps">
        <li className={hasApiKey ? "done" : ""}>
          <span className="step-num">1</span>
          <div>
            <strong>Configure AI</strong>
            {hasApiKey ? (
              <span className="step-status">Ready</span>
            ) : (
              <button type="button" className="link-btn" onClick={onOpenSettings}>
                Open settings
              </button>
            )}
          </div>
        </li>
        <li className={hasDocument ? "done" : ""}>
          <span className="step-num">2</span>
          <div>
            <strong>Open a document</strong>
            {!hasDocument && (
              <button type="button" className="link-btn" onClick={onOpenFile}>
                Choose file
              </button>
            )}
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Ask anything</strong>
            <div className="example-chips">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="chip"
                  disabled={!hasDocument || !hasApiKey}
                  onClick={() => onSendExample(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}
