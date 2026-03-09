import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useSearch } from '../hooks/useSearch';
import EntityCard from '../components/shared/EntityCard';
import type { SearchResult, NameLookup, EntityType } from '../types';

import tribesData from '../data/tribes.json';
import familiesData from '../data/families.json';
import nameLookupData from '../data/nameLookup.json';
import ethnicGroupsData from '../data/ethnicGroups.json';
import eventsData from '../data/events.json';
import connectionsData from '../data/connections.json';

const SUGGESTION_CHIPS = [
  "What's the connection between Bahrain and Kuwait's rulers?",
  'Who lived in Bahrain before the Al Khalifa?',
  'Which tribes span multiple countries?',
  'What does Al-Balushi mean?',
  'Al Nahyan',
  'Bani Yas',
  'Jewish families in Bahrain',
  'Ghafiri vs Hinawi',
];

const ORIGIN_BADGE_STYLES: Record<string, { bg: string; text: string }> = {
  tribal: { bg: 'bg-accent/20', text: 'text-accent' },
  ethnic: { bg: 'bg-teal/20', text: 'text-teal-dark' },
  geographic: { bg: 'bg-[#2980B9]/20', text: 'text-[#2980B9]' },
  occupational: { bg: 'bg-purple/20', text: 'text-purple' },
  religious: { bg: 'bg-red/20', text: 'text-red' },
};

const EXPLORE_CATEGORIES = [
  {
    title: 'Tribal Confederations',
    description: 'Explore the complex web of Arabian tribal alliances and hierarchies',
    icon: ShieldIcon,
    count: tribesData.length,
    route: '/tree',
  },
  {
    title: 'Ruling Families',
    description: 'The dynasties that shaped the Gulf states',
    icon: CrownIcon,
    count: (familiesData as { isRuling: number }[]).filter((f) => f.isRuling).length,
    route: '/tree',
  },
  {
    title: 'Historical Events',
    description: 'Key moments that defined the region',
    icon: ScrollIcon,
    count: eventsData.length,
    route: '/timeline',
  },
  {
    title: 'Ethnic Groups',
    description: 'The diverse communities of the Arabian Peninsula',
    icon: PeopleIcon,
    count: ethnicGroupsData.length,
    route: '/map',
  },
  {
    title: 'Cross-Border Connections',
    description: 'Tribal and family ties that transcend national boundaries',
    icon: NetworkIcon,
    count: connectionsData.length,
    route: '/connections',
  },
];

const TYPE_LABELS: Record<EntityType, string> = {
  tribe: 'Tribes',
  family: 'Families',
  figure: 'Notable Figures',
  ethnic: 'Ethnic Groups',
  event: 'Historical Events',
  region: 'Regions',
};

const TYPE_ORDER: EntityType[] = ['tribe', 'family', 'figure', 'ethnic', 'event', 'region'];

function findNameLookup(query: string): NameLookup | null {
  const q = query.toLowerCase().trim();
  return (
    (nameLookupData as NameLookup[]).find(
      (nl) =>
        nl.surname.toLowerCase() === q ||
        nl.surnameAr === q ||
        nl.variants?.some((v) => v.toLowerCase() === q),
    ) ?? null
  );
}

interface SearchViewProps {
  onSelectEntity?: (type: EntityType, id: string) => void;
}

export default function SearchView({ onSelectEntity }: SearchViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { search } = useSearch();

  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [isFocused, setIsFocused] = useState(false);

  const results = useMemo(() => search(query), [search, query]);
  const nameLookupMatch = useMemo(() => (query.length >= 2 ? findNameLookup(query) : null), [query]);

  const groupedResults = useMemo(() => {
    const groups: Partial<Record<EntityType, SearchResult[]>> = {};
    for (const r of results) {
      (groups[r.type] ??= []).push(r);
    }
    return groups;
  }, [results]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (query) {
        setSearchParams({ q: query }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, setSearchParams]);

  const handleEntityClick = (type: EntityType, id: string) => {
    if (onSelectEntity) {
      onSelectEntity(type, id);
    }
  };

  const handleChipClick = (text: string) => {
    setQuery(text);
  };

  const hasResults = results.length > 0;
  const showEmptyState = !query.trim();

  return (
    <div className="min-h-[calc(100vh-4rem)]">
      {/* Hero Section */}
      <section className="relative">
        <div className="relative max-w-4xl mx-auto px-4 pt-20 pb-10 md:pt-32 md:pb-14">
          {/* Title */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <h1 className="font-display text-5xl md:text-7xl font-bold text-text mb-4 tracking-tight">
              Who Are You?
            </h1>
            <p className="font-body text-text-secondary text-lg md:text-xl max-w-xl mx-auto">
              Explore your heritage through Arabian tribal lineages
            </p>
          </motion.div>

          {/* Search Bar */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="relative max-w-2xl mx-auto"
          >
            <div
              className={`relative rounded-2xl transition-all duration-300 ${
                isFocused
                  ? 'shadow-[0_0_0_2px_rgba(196,100,58,0.3)] shadow-lg'
                  : 'border border-border shadow-sm'
              }`}
            >
              <div className="absolute left-5 top-1/2 -translate-y-1/2 text-text-tertiary">
                <SearchIcon />
              </div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder="Enter a family name, tribe, or ask a question..."
                className="w-full bg-white rounded-2xl py-5 pl-14 pr-12
                           font-body text-lg text-text placeholder:text-text-tertiary
                           outline-none border-none"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  <ClearIcon />
                </button>
              )}
            </div>
          </motion.div>

          {/* Suggestion Chips */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="flex flex-wrap justify-center gap-2 mt-6 max-w-3xl mx-auto"
          >
            {SUGGESTION_CHIPS.map((chip) => (
              <button
                key={chip}
                onClick={() => handleChipClick(chip)}
                className="px-4 py-1.5 rounded-full bg-bg-subtle border border-border
                           font-display italic text-sm text-text-secondary
                           hover:border-border-strong hover:bg-bg-raised hover:text-text
                           transition-all duration-200 cursor-pointer"
              >
                {chip}
              </button>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Results / Empty State */}
      <section className="max-w-6xl mx-auto px-4 pb-20">
        <AnimatePresence mode="wait">
          {showEmptyState ? (
            <EmptyState key="empty" onNavigate={navigate} />
          ) : hasResults || nameLookupMatch ? (
            <ResultsSection
              key="results"
              query={query}
              nameLookupMatch={nameLookupMatch}
              groupedResults={groupedResults}
              onEntityClick={handleEntityClick}
            />
          ) : (
            <NoResults key="no-results" query={query} />
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

/* ─── Name Origin Card ─── */

function NameOriginCard({
  match,
  onEntityClick,
}: {
  match: NameLookup;
  onEntityClick: (type: EntityType, id: string) => void;
}) {
  const badgeStyle = ORIGIN_BADGE_STYLES[match.originType ?? ''] ?? ORIGIN_BADGE_STYLES.tribal;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4 }}
      className="relative bg-bg-raised border border-border rounded-2xl p-6 md:p-8 mb-8
                 shadow-sm"
    >
      <div className="flex flex-col md:flex-row md:items-start gap-6">
        {/* Name Display */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-3">
            <p className="text-xs font-medium uppercase tracking-widest text-text-tertiary">Name Origin</p>
            {match.originType && (
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${badgeStyle.bg} ${badgeStyle.text}`}
              >
                {match.originType}
              </span>
            )}
          </div>

          <h2 className="font-display text-3xl md:text-4xl font-bold text-text mb-1">
            {match.surname}
          </h2>
          {match.surnameAr && (
            <p className="text-lg text-text-secondary mb-4" dir="rtl">
              {match.surnameAr}
            </p>
          )}

          {match.meaning && (
            <p className="text-text-secondary text-base leading-relaxed mb-4">
              <span className="font-semibold text-text">Meaning:</span> {match.meaning}
            </p>
          )}

          {match.variants && match.variants.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary mb-2">
                Variants
              </p>
              <div className="flex flex-wrap gap-2">
                {match.variants.map((v) => (
                  <span
                    key={v}
                    className="px-3 py-1 rounded-full bg-bg-subtle text-sm text-text-secondary font-body"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {match.funFact && (
            <div className="bg-bg-subtle border border-border rounded-xl p-4 mt-3">
              <p className="text-sm text-text-secondary leading-relaxed">
                <span className="text-accent font-semibold">Did you know?</span> {match.funFact}
              </p>
            </div>
          )}
        </div>

        {/* Link to related entity */}
        {match.linkedEntity && (
          <div className="shrink-0">
            <button
              onClick={() =>
                handleLinkedEntityClick(match.linkedEntity!, onEntityClick)
              }
              className="group flex items-center gap-2 px-5 py-3 rounded-xl
                         bg-text text-bg-raised font-body text-sm font-medium
                         hover:opacity-90 transition-opacity cursor-pointer"
            >
              <span>View {match.linkedEntity.type === 'ethnic_group' ? 'Ethnic Group' : capitalize(match.linkedEntity.type)}</span>
              <ArrowIcon />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function handleLinkedEntityClick(
  linked: { type: string; id: string },
  onEntityClick: (type: EntityType, id: string) => void,
) {
  const typeMap: Record<string, EntityType> = {
    tribe: 'tribe',
    family: 'family',
    ethnic_group: 'ethnic',
    event: 'event',
    region: 'region',
    figure: 'figure',
  };
  const mappedType = typeMap[linked.type] ?? 'tribe';
  onEntityClick(mappedType, linked.id);
}

/* ─── Results Section ─── */

function ResultsSection({
  query,
  nameLookupMatch,
  groupedResults,
  onEntityClick,
}: {
  query: string;
  nameLookupMatch: NameLookup | null;
  groupedResults: Partial<Record<EntityType, SearchResult[]>>;
  onEntityClick: (type: EntityType, id: string) => void;
}) {
  const totalResults = Object.values(groupedResults).reduce((sum, arr) => sum + (arr?.length ?? 0), 0);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Name Origin Card */}
      {nameLookupMatch && (
        <NameOriginCard match={nameLookupMatch} onEntityClick={onEntityClick} />
      )}

      {/* Result count */}
      {totalResults > 0 && (
        <p className="text-sm text-text-tertiary mb-6 font-body">
          {totalResults} result{totalResults !== 1 ? 's' : ''} for{' '}
          <span className="text-text-secondary font-medium">"{query}"</span>
        </p>
      )}

      {/* Grouped results */}
      {TYPE_ORDER.map((type) => {
        const items = groupedResults[type];
        if (!items || items.length === 0) return null;

        return (
          <div key={type} className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <h3 className="font-display text-xl font-semibold text-text">{TYPE_LABELS[type]}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-bg-subtle text-text-tertiary font-medium">
                {items.length}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((result, i) => (
                <motion.div
                  key={`${result.type}-${result.id}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                >
                  <EntityCard
                    type={result.type}
                    name={result.name}
                    description={result.snippet}
                    onClick={() => onEntityClick(result.type, result.id)}
                  />
                </motion.div>
              ))}
            </div>
          </div>
        );
      })}
    </motion.div>
  );
}

/* ─── No Results ─── */

function NoResults({ query }: { query: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="text-center py-16"
    >
      <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-bg-subtle flex items-center justify-center">
        <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
      </div>
      <p className="font-display text-2xl text-text-secondary mb-2">No results found</p>
      <p className="text-text-tertiary text-sm">
        No matches for "<span className="font-medium">{query}</span>". Try a different name, tribe, or question.
      </p>
    </motion.div>
  );
}

/* ─── Empty State (Explore) ─── */

function EmptyState({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="text-center mb-8 mt-4">
        <div className="border-b border-border max-w-xs mx-auto mb-6" />
        <h2 className="font-display text-2xl font-semibold text-text mb-1">Explore</h2>
        <p className="text-text-tertiary text-sm">Dive into the rich tapestry of Arabian heritage</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
        {EXPLORE_CATEGORIES.map((cat, i) => (
          <motion.button
            key={cat.title}
            onClick={() => onNavigate(cat.route)}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.06 }}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.98 }}
            className="group relative bg-bg-raised border border-border
                       rounded-2xl p-6 text-left cursor-pointer
                       hover:border-border-strong hover:shadow-md
                       transition-all duration-300"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-10 h-10 rounded-xl bg-bg-subtle flex items-center justify-center text-accent
                              group-hover:bg-accent/10 transition-colors">
                <cat.icon />
              </div>
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-bg-subtle text-text-tertiary">
                {cat.count}
              </span>
            </div>
            <h3 className="font-display text-lg font-semibold text-text mb-1.5 group-hover:text-accent transition-colors">
              {cat.title}
            </h3>
            <p className="text-xs text-text-tertiary leading-relaxed">{cat.description}</p>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

/* ─── Icons ─── */

function SearchIcon() {
  return (
    <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="group-hover:translate-x-0.5 transition-transform">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 17l2-11 4 4 4-7 4 7 4-4 2 11H2z" />
    </svg>
  );
}

function ScrollIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
    </svg>
  );
}

function NetworkIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

/* ─── Helpers ─── */

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
