import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import type { ConversationKeys } from "../hooks/useConversationKeys";

interface ConversationSearchBarProps {
  keys: ConversationKeys;
}

/**
 * The find bar over a conversation.
 *
 * Rendered only while open; the state and the key handling live in
 * useConversationKeys, which the panel root owns because the chord has to work
 * from the composer too.
 */
export function ConversationSearchBar({ keys }: ConversationSearchBarProps) {
  const { t } = useI18n();
  const { searchQuery, setSearchQuery, closeSearch, matches, matchIndex, gotoMatch } = keys;
  const empty = matches.length === 0;

  return (
    <div className="chat-search" role="search">
      <Input
        ref={keys.searchRef}
        size="sm"
        className="chat-search-input"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t("agent.searchConversation")}
        aria-label={t("agent.searchConversation")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            closeSearch();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            gotoMatch(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="chat-search-count" aria-live="polite">
        {searchQuery.trim()
          ? t("agent.searchCount", {
              index: empty ? 0 : matchIndex + 1,
              total: matches.length,
            })
          : ""}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon
        onClick={() => gotoMatch(-1)}
        disabled={empty}
        aria-label={t("agent.searchPrev")}
      >
        ↑
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon
        onClick={() => gotoMatch(1)}
        disabled={empty}
        aria-label={t("agent.searchNext")}
      >
        ↓
      </Button>
      <Button variant="ghost" size="sm" icon onClick={closeSearch} aria-label={t("common.close")}>
        ✕
      </Button>
    </div>
  );
}
