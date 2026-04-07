import React, { useCallback, useEffect, useRef, useState } from "react";
import { searchMessages, SearchResult } from "../api/search";

interface Props {
  /** "dm" scoped to a single conversation, "community" scoped to all accessible channels */
  scope: "dm" | "community";
  /** Required when scope="dm" */
  conversationId?: string;
  /** Required when scope="community" */
  communityId?: string;
  /** Maps user IDs to display names for showing author names */
  displayNames?: Record<string, string>;
  /** Called when user clicks a search result — parent can scroll/navigate to it */
  onJump?: (result: SearchResult) => void;
  onClose: () => void;
}

export default function SearchPanel({ scope, conversationId, communityId, displayNames, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // Filters
  const [authorFilter, setAuthorFilter] = useState("");
  const [afterFilter, setAfterFilter] = useState("");
  const [beforeFilter, setBeforeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setTotal(0);
      setSearched(false);
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const data = await searchMessages({
        q: q.trim(),
        scope,
        conversationId: scope === "dm" ? conversationId : undefined,
        communityId: scope === "community" ? communityId : undefined,
        authorId: authorFilter || undefined,
        after: afterFilter || undefined,
        before: beforeFilter || undefined,
        limit: 25,
      });
      setResults(data.results);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [scope, conversationId, communityId, authorFilter, afterFilter, beforeFilter]);

  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void doSearch(value), 350);
  }, [doSearch]);

  // Re-search when filters change (if there's already a query)
  useEffect(() => {
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void doSearch(query), 350);
    }
  }, [authorFilter, afterFilter, beforeFilter]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void doSearch(query);
  };

  function authorName(authorId: string, username: string): string {
    return displayNames?.[authorId] ?? username;
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-surface-container">
      {/* Search header */}
      <div className="px-4 py-3 bg-[#171a1f]/80 backdrop-blur-xl border-b border-outline-variant/20">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <span className="material-symbols-outlined text-on-surface-variant text-[20px]">search</span>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-surface-container-lowest border-none rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
            placeholder="Search messages..."
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-colors ${
              showFilters || authorFilter || afterFilter || beforeFilter
                ? "text-primary bg-primary/10"
                : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
            }`}
            title="Filters"
          >
            <span className="material-symbols-outlined text-[18px]">tune</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface text-xs px-2 py-1.5 rounded hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </form>

        {/* Filters */}
        {showFilters && (
          <div className="mt-3 flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Author ID</label>
              <input
                type="text"
                className="bg-surface-container-lowest border-none rounded-lg px-2 py-1 text-xs text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary w-48"
                placeholder="Filter by author UUID..."
                value={authorFilter}
                onChange={(e) => setAuthorFilter(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">After</label>
              <input
                type="date"
                className="bg-surface-container-lowest border-none rounded-lg px-2 py-1 text-xs text-on-surface focus:ring-1 focus:ring-primary"
                value={afterFilter}
                onChange={(e) => setAfterFilter(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Before</label>
              <input
                type="date"
                className="bg-surface-container-lowest border-none rounded-lg px-2 py-1 text-xs text-on-surface focus:ring-1 focus:ring-primary"
                value={beforeFilter}
                onChange={(e) => setBeforeFilter(e.target.value)}
              />
            </div>
            {(authorFilter || afterFilter || beforeFilter) && (
              <button
                type="button"
                onClick={() => { setAuthorFilter(""); setAfterFilter(""); setBeforeFilter(""); }}
                className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && (
          <p className="text-center text-sm text-on-surface-variant py-6">Searching...</p>
        )}

        {error && (
          <p className="text-center text-sm text-red-400 py-6">{error}</p>
        )}

        {!loading && searched && results.length === 0 && !error && (
          <p className="text-center text-sm text-on-surface-variant py-6">No results found.</p>
        )}

        {!loading && searched && results.length > 0 && (
          <div className="mb-2 text-xs text-on-surface-variant">
            {total} result{total !== 1 ? "s" : ""} found
          </div>
        )}

        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <button
              key={r.message_id}
              type="button"
              onClick={() => onJump?.(r)}
              className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors text-left w-full"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-on-surface">{authorName(r.author_id, r.author_username)}</span>
                {r.channel_name && (
                  <span className="text-[10px] text-on-surface-variant">#{r.channel_name}</span>
                )}
                <span className="text-[10px] text-on-surface-variant ml-auto">
                  {new Date(r.created_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}{" "}
                  {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p
                className="text-sm text-on-surface-variant leading-snug [&>em]:text-on-surface [&>em]:font-semibold [&>em]:not-italic"
                dangerouslySetInnerHTML={{ __html: r.highlight }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
