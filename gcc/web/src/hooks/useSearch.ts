import { useMemo, useCallback } from 'react';
import Fuse from 'fuse.js';
import type { SearchResult, EntityType } from '../types';

import tribesData from '../data/tribes.json';
import familiesData from '../data/families.json';
import ethnicGroupsData from '../data/ethnicGroups.json';
import eventsData from '../data/events.json';
import regionsData from '../data/regions.json';
import nameLookupData from '../data/nameLookup.json';

interface SearchEntry {
  type: EntityType;
  id: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  meaning: string | null;
  variants: string[];
}

function buildSearchEntries(): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const t of tribesData) {
    entries.push({
      type: 'tribe',
      id: t.id,
      name: t.name,
      nameAr: t.nameAr,
      description: t.description,
      meaning: null,
      variants: [],
    });
  }

  for (const f of familiesData) {
    entries.push({
      type: 'family',
      id: f.id,
      name: f.name,
      nameAr: f.nameAr,
      description: f.description,
      meaning: null,
      variants: [],
    });

    for (const fig of f.notableFigures) {
      entries.push({
        type: 'figure',
        id: fig.id,
        name: fig.name,
        nameAr: fig.nameAr,
        description: fig.significance,
        meaning: null,
        variants: [],
      });
    }
  }

  for (const eg of ethnicGroupsData) {
    entries.push({
      type: 'ethnic',
      id: eg.id,
      name: eg.name,
      nameAr: eg.nameAr,
      description: eg.description,
      meaning: null,
      variants: [],
    });
  }

  for (const ev of eventsData) {
    entries.push({
      type: 'event',
      id: ev.id,
      name: ev.title,
      nameAr: ev.titleAr,
      description: ev.description ?? ev.significance,
      meaning: null,
      variants: [],
    });
  }

  for (const r of regionsData) {
    entries.push({
      type: 'region',
      id: r.id,
      name: r.name,
      nameAr: r.nameAr,
      description: r.strategicImportance,
      meaning: null,
      variants: [],
    });
  }

  for (const nl of nameLookupData) {
    const linked = nl.linkedEntity;
    if (linked) {
      entries.push({
        type: linked.type as EntityType,
        id: linked.id,
        name: nl.surname,
        nameAr: nl.surnameAr,
        description: nl.funFact,
        meaning: nl.meaning,
        variants: nl.variants ?? [],
      });
    }
  }

  return entries;
}

const fuseOptions = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'nameAr', weight: 1.5 },
    { name: 'description', weight: 0.5 },
    { name: 'meaning', weight: 0.8 },
    { name: 'variants', weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
  includeMatches: true,
};

export function useSearch() {
  const fuse = useMemo(() => {
    const entries = buildSearchEntries();
    return new Fuse(entries, fuseOptions);
  }, []);

  const suggestions = useMemo(() => {
    const names: string[] = [];
    for (const t of tribesData.slice(0, 20)) names.push(t.name);
    for (const f of familiesData.slice(0, 10)) names.push(f.name);
    for (const eg of ethnicGroupsData.slice(0, 5)) names.push(eg.name);
    return names;
  }, []);

  const search = useCallback(
    (query: string): SearchResult[] => {
      if (!query.trim()) return [];

      const results = fuse.search(query, { limit: 30 });

      // Deduplicate by type+id, keeping the best score
      const seen = new Set<string>();
      const deduped: SearchResult[] = [];

      for (const r of results) {
        const key = `${r.item.type}:${r.item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        deduped.push({
          type: r.item.type,
          id: r.item.id,
          name: r.item.name,
          nameAr: r.item.nameAr,
          snippet: r.item.description ?? '',
          score: r.score ?? 1,
        });
      }

      return deduped;
    },
    [fuse],
  );

  return { search, suggestions };
}
