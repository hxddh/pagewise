import { useCallback, useState } from "react";
import type { UIMessage } from "ai";
import { addFinding } from "../../lib/finding-store";
import type { LoadedDocument } from "../../lib/types";

export interface RecordBridge {
  /** A turn the record asked to see, with a nonce so the same one works twice. */
  revealTarget: { id: string; nonce: number } | null;
  /** Does the conversation still hold this turn? */
  hasMessage: (messageId: string) => boolean;
  /** Switch to the transcript and point at one turn. */
  revealMessage: (messageId: string) => void;
  /** Keep a whole answer in the record, as the reader's own entry. */
  keepClaim: (claim: string, pages: number[], source: { body: string; messageId: string }) => void;
  /** Keep the sentences whose citations were found, one entry each. */
  keepVerified: (sentences: Array<{ claim: string; page: number; quote: string }>, messageId: string) => void;
}

/**
 * The two halves of the record, talking to each other: entries kept from an
 * answer are marked as the reader's (a record that cannot tell what the
 * assistant inferred from what the reader chose to keep is the failure this
 * avoids), and the whole answer travels with the claim. No toast on Keep —
 * the button relabels, which is feedback where the action happened.
 */
export function useRecordBridge({
  doc,
  messages,
  setTab,
}: {
  doc: LoadedDocument | null;
  messages: UIMessage[];
  setTab: (tab: "chat" | "record") => void;
}): RecordBridge {
  const [revealTarget, setRevealTarget] = useState<{ id: string; nonce: number } | null>(null);

  const hasMessage = useCallback(
    (messageId: string) => messages.some((m) => m.id === messageId),
    [messages],
  );
  const revealMessage = useCallback(
    (messageId: string) => {
      setTab("chat");
      setRevealTarget({ id: messageId, nonce: Date.now() });
    },
    [setTab],
  );
  const keepClaim = useCallback(
    (claim: string, pages: number[], source: { body: string; messageId: string }) => {
      if (!doc) return;
      addFinding(doc.path, {
        pages,
        claim,
        stamp: doc.stamp ?? "",
        author: "reader",
        body: source.body,
        source: { messageId: source.messageId },
      });
    },
    [doc],
  );
  const keepVerified = useCallback(
    (sentences: Array<{ claim: string; page: number; quote: string }>, messageId: string) => {
      if (!doc) return;
      // One entry per verified sentence, each carrying the words its page was
      // found to have — so it enters the record as found, not as a claim.
      for (const s of sentences) {
        addFinding(doc.path, {
          pages: [s.page],
          claim: s.claim,
          evidence: s.quote,
          stamp: doc.stamp ?? "",
          author: "reader",
          source: { messageId },
        });
      }
    },
    [doc],
  );

  return { revealTarget, hasMessage, revealMessage, keepClaim, keepVerified };
}
