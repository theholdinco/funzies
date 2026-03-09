import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { motion, AnimatePresence } from 'motion/react';
import Fuse from 'fuse.js';
import regionsData from '../data/regions.json';
import tribesData from '../data/tribes.json';
import familiesData from '../data/families.json';
import type { Region, Tribe, Family } from '../types';

const regions = regionsData as Region[];
const tribes = tribesData as Tribe[];
const families = familiesData as Family[];

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

const COUNTRY_COLORS: Record<string, string> = {
  UAE: '#2C3E50',
  'Saudi Arabia': '#C4A265',
  Qatar: '#C0392B',
  Bahrain: '#8E44AD',
  Kuwait: '#1ABC9C',
  Oman: '#2980B9',
  Iran: '#777',
  Iraq: '#777',
};

const ALIGNMENT_COLORS: Record<string, string> = {
  ghafiri: '#C0392B',
  hinawi: '#2980B9',
  neutral: '#888888',
};

const PRESENCE_OPACITY: Record<string, number> = {
  dominant: 1.0,
  ruling: 0.9,
  significant: 0.8,
  minority: 0.5,
  historical_only: 0.3,
};

interface SearchableEntity {
  id: string;
  name: string;
  type: 'tribe' | 'family';
}

export default function MapView() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [showAlignment, setShowAlignment] = useState(false);
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [selectedTribe, setSelectedTribe] = useState<string | null>(null);
  const [tribeQuery, setTribeQuery] = useState('');
  const [tribeDropdownOpen, setTribeDropdownOpen] = useState(false);
  const tribeSearchRef = useRef<HTMLDivElement>(null);

  // Regions with coordinates and entities
  const geoRegions = useMemo(
    () => regions.filter((r) => r.lat && r.lng && r.entities.length > 0),
    [],
  );

  // Tribe alignment map
  const tribeAlignmentMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tribes) if (t.alignment) map.set(t.id, t.alignment);
    return map;
  }, []);

  // Dominant alignment per region
  const regionAlignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of geoRegions) {
      const counts: Record<string, number> = {};
      for (const tId of r.dominantTribes) {
        const a = tribeAlignmentMap.get(tId);
        if (a && a !== 'na') counts[a] = (counts[a] || 0) + 1;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) map.set(r.id, top[0]);
    }
    return map;
  }, [geoRegions, tribeAlignmentMap]);

  // Lookup maps
  const familyNameMap = useMemo(() => {
    const map = new Map<string, Family>();
    for (const f of families) map.set(f.id, f);
    return map;
  }, []);

  const tribeNameMap = useMemo(() => {
    const map = new Map<string, Tribe>();
    for (const t of tribes) map.set(t.id, t);
    return map;
  }, []);

  // Available countries
  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const r of geoRegions) if (r.country) set.add(r.country);
    return Array.from(set).sort();
  }, [geoRegions]);

  // Searchable tribe/family list for the combobox
  const searchableEntities = useMemo<SearchableEntity[]>(() => {
    const items: SearchableEntity[] = [];
    for (const t of tribes) items.push({ id: t.id, name: t.name, type: 'tribe' });
    for (const f of families) items.push({ id: f.id, name: f.name, type: 'family' });
    return items;
  }, []);

  const fuse = useMemo(
    () => new Fuse(searchableEntities, { keys: ['name'], threshold: 0.35 }),
    [searchableEntities],
  );

  const tribeSearchResults = useMemo(() => {
    if (!tribeQuery.trim()) return searchableEntities.slice(0, 15);
    return fuse.search(tribeQuery, { limit: 15 }).map((r) => r.item);
  }, [tribeQuery, fuse, searchableEntities]);

  // Regions where the selected tribe/family is present, with presence info
  const highlightedRegions = useMemo(() => {
    if (!selectedTribe) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const r of geoRegions) {
      for (const e of r.entities) {
        if (e.id === selectedTribe) {
          map.set(r.id, e.presenceType || 'significant');
          break;
        }
      }
    }
    return map;
  }, [selectedTribe, geoRegions]);

  // Connection lines GeoJSON between highlighted regions
  const connectionsGeoJson = useMemo((): GeoJSON.FeatureCollection => {
    if (!selectedTribe || highlightedRegions.size < 2) {
      return { type: 'FeatureCollection', features: [] };
    }

    const presenceOrder = ['dominant', 'ruling', 'significant', 'minority', 'historical_only'];
    const sorted = Array.from(highlightedRegions.entries())
      .map(([regionId, presence]) => {
        const r = geoRegions.find((reg) => reg.id === regionId)!;
        return { regionId, presence, lat: r.lat!, lng: r.lng! };
      })
      .sort((a, b) => presenceOrder.indexOf(a.presence) - presenceOrder.indexOf(b.presence));

    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [sorted[i].lng, sorted[i].lat],
            [sorted[i + 1].lng, sorted[i + 1].lat],
          ],
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }, [selectedTribe, highlightedRegions, geoRegions]);

  // Close tribe dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (tribeSearchRef.current && !tribeSearchRef.current.contains(e.target as Node)) {
        setTribeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Build GeoJSON for markers
  const buildGeoJson = useCallback(
    (alignment: boolean, filter: string | null, highlightTribe: Map<string, string> | null): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: geoRegions
        .filter((r) => !filter || r.country === filter)
        .map((r) => {
          const alg = regionAlignment.get(r.id);
          const baseColor = alignment && alg
            ? ALIGNMENT_COLORS[alg] || '#888'
            : r.country ? COUNTRY_COLORS[r.country] || '#C4A265' : '#C4A265';

          const presence = highlightTribe?.get(r.id) ?? null;
          const isHighlighted = highlightTribe ? presence !== null : true;
          const color = isHighlighted && presence ? '#C4643A' : baseColor;
          const opacity = highlightTribe
            ? (presence ? (PRESENCE_OPACITY[presence] ?? 0.7) : 0.12)
            : 0.75;

          return {
            type: 'Feature' as const,
            properties: {
              id: r.id,
              name: r.name,
              country: r.country || '',
              type: r.type || '',
              entityCount: r.entities.length,
              tribeCount: r.dominantTribes.length,
              color,
              opacity,
              size: Math.max(6, Math.min(24, Math.sqrt(r.entities.length) * 5)),
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [r.lng!, r.lat!],
            },
          };
        }),
    }),
    [geoRegions, regionAlignment],
  );

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const container = mapContainerRef.current;
    let map: mapboxgl.Map | null = null;

    // Defer to next frame so the container has layout dimensions
    const rafId = requestAnimationFrame(() => {
      map = new mapboxgl.Map({
        container,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [51, 25],
        zoom: 5,
        minZoom: 3,
        maxZoom: 12,
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-right');

      map.on('load', () => {
        if (!map) return;
        mapRef.current = map;

        map.addSource('regions', {
          type: 'geojson',
          data: buildGeoJson(false, null, null),
        });

        map.addSource('tribe-connections', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'tribe-connection-lines',
          type: 'line',
          source: 'tribe-connections',
          paint: {
            'line-color': '#C4643A',
            'line-width': 1.5,
            'line-opacity': 0.4,
            'line-dasharray': [4, 3],
          },
        });

        map.addLayer({
          id: 'region-halos',
          type: 'circle',
          source: 'regions',
          paint: {
            'circle-radius': ['get', 'size'],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['*', ['get', 'opacity'], 0.2],
            'circle-blur': 0.8,
          },
        });

        map.addLayer({
          id: 'region-circles',
          type: 'circle',
          source: 'regions',
          paint: {
            'circle-radius': ['*', ['get', 'size'], 0.5],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['get', 'opacity'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-opacity': 0.4,
          },
        });

        map.addLayer({
          id: 'region-labels',
          type: 'symbol',
          source: 'regions',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-size': 11,
            'text-offset': [0, -1.4],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#1A1A1A',
            'text-halo-color': '#FFFFFF',
            'text-halo-width': 1.5,
            'text-opacity': 0.8,
          },
        });

        map.on('mouseenter', 'region-circles', (e) => {
          if (!map) return;
          map.getCanvas().style.cursor = 'pointer';
          if (!e.features?.[0]) return;
          const props = e.features[0].properties!;
          const coords = (e.features[0].geometry as GeoJSON.Point).coordinates.slice() as [number, number];

          if (popupRef.current) popupRef.current.remove();

          popupRef.current = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'ansab-popup',
            offset: 14,
          })
            .setLngLat(coords)
            .setHTML(`
              <div style="font-family: 'Instrument Serif', serif; font-weight: 700; font-size: 14px; color: #1A1A1A;">
                ${props.name}
              </div>
              <div style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 11px; color: #1A1A1A; opacity: 0.6; margin-top: 4px;">
                ${props.type ? `<span style="text-transform: capitalize;">${props.type}</span>` : ''}
                ${props.country ? ` &middot; ${props.country}` : ''}
              </div>
              <div style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 11px; color: #1A1A1A; opacity: 0.7; margin-top: 2px;">
                ${props.entityCount} entities &middot; ${props.tribeCount} tribes
              </div>
            `)
            .addTo(map);
        });

        map.on('mouseleave', 'region-circles', () => {
          if (!map) return;
          map.getCanvas().style.cursor = '';
          if (popupRef.current) {
            popupRef.current.remove();
            popupRef.current = null;
          }
        });

        map.on('click', 'region-circles', (e) => {
          if (!e.features?.[0]) return;
          const regionId = e.features[0].properties!.id;
          const region = geoRegions.find((r) => r.id === regionId);
          if (region) setSelectedRegion((prev) => prev?.id === region.id ? null : region);
        });

        map.resize();
        setMapLoaded(true);
      });

      map.on('error', (e) => {
        console.error('Mapbox error:', e.error);
      });
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (map) {
        map.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers when filters change
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const regionSource = mapRef.current.getSource('regions') as mapboxgl.GeoJSONSource;
    if (regionSource) {
      const highlight = selectedTribe ? highlightedRegions : null;
      regionSource.setData(buildGeoJson(showAlignment, countryFilter, highlight));
    }
    const connSource = mapRef.current.getSource('tribe-connections') as mapboxgl.GeoJSONSource;
    if (connSource) {
      connSource.setData(connectionsGeoJson);
    }
  }, [showAlignment, countryFilter, mapLoaded, buildGeoJson, selectedTribe, highlightedRegions, connectionsGeoJson]);

  // Fly to selected region
  useEffect(() => {
    if (!mapRef.current || !selectedRegion?.lat || !selectedRegion?.lng) return;
    mapRef.current.flyTo({
      center: [selectedRegion.lng, selectedRegion.lat],
      zoom: Math.max(mapRef.current.getZoom(), 7),
      duration: 800,
    });
  }, [selectedRegion]);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-3 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-text">
            The Gulf
          </h1>
          <p className="text-text-tertiary text-sm mt-1">
            {geoRegions.length} mapped regions &middot; Click a marker to explore
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Tribe/Family search */}
          <div ref={tribeSearchRef} className="relative">
            {selectedTribe ? (
              <button
                onClick={() => {
                  setSelectedTribe(null);
                  setTribeQuery('');
                }}
                className="text-xs bg-accent text-white border border-accent rounded-lg px-3 py-1.5
                           flex items-center gap-1.5 hover:bg-accent-hover transition-colors"
              >
                <span className="max-w-[140px] truncate">
                  {searchableEntities.find((e) => e.id === selectedTribe)?.name || selectedTribe}
                </span>
                <span className="opacity-70">&times;</span>
              </button>
            ) : (
              <input
                type="text"
                value={tribeQuery}
                onChange={(e) => {
                  setTribeQuery(e.target.value);
                  setTribeDropdownOpen(true);
                }}
                onFocus={() => setTribeDropdownOpen(true)}
                placeholder="Search tribe / family..."
                className="text-xs bg-bg-subtle border border-border rounded-lg px-3 py-1.5 text-text w-48
                           focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-tertiary"
              />
            )}
            {tribeDropdownOpen && !selectedTribe && (
              <div className="absolute top-full left-0 mt-1 w-64 max-h-56 overflow-y-auto z-50
                             bg-bg-raised border border-border rounded-xl shadow-lg">
                {tribeSearchResults.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-text-tertiary">No results</div>
                ) : (
                  tribeSearchResults.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSelectedTribe(item.id);
                        setTribeQuery('');
                        setTribeDropdownOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-subtle flex items-center gap-2
                                 transition-colors cursor-pointer"
                    >
                      <span className={`${item.type === 'tribe' ? 'badge-tribe' : 'badge-family'}
                                       text-[9px] px-1.5 py-0.5 rounded-full`}>
                        {item.type}
                      </span>
                      <span className="text-text truncate">{item.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <select
            value={countryFilter || ''}
            onChange={(e) => setCountryFilter(e.target.value || null)}
            className="text-xs bg-bg-subtle border border-border rounded-lg px-3 py-1.5 text-text
                       focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">All Countries</option>
            {countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <button
            onClick={() => setShowAlignment(!showAlignment)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              showAlignment
                ? 'bg-text text-white border-text'
                : 'bg-bg-subtle border-border text-text hover:border-accent'
            }`}
          >
            Ghafiri / Hinawi
          </button>
        </div>
      </div>

      <div className="h-px bg-border mx-6" />

      {/* Map + sidebar */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Mapbox container */}
        <div className="flex-1 relative min-h-0 min-w-0">
          <div ref={mapContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }} />

          {/* Alignment legend */}
          <AnimatePresence>
            {showAlignment && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="absolute bottom-4 left-4 z-10 bg-bg-raised backdrop-blur border border-border
                           rounded-xl px-3 py-2 text-xs shadow"
            >
              <div className="font-display font-semibold text-text text-xs mb-1.5">Tribal Alignment</div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-full" style={{ background: '#C0392B' }} />
                <span className="text-text-secondary">Ghafiri</span>
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-full" style={{ background: '#2980B9' }} />
                <span className="text-text-secondary">Hinawi</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-gray-400" />
                <span className="text-text-secondary">Neutral</span>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Presence legend */}
          <AnimatePresence>
            {selectedTribe && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="absolute bottom-4 left-4 z-10 bg-bg-raised backdrop-blur border border-border
                           rounded-xl px-3 py-2 text-xs shadow"
                style={{ left: showAlignment ? 160 : 16 }}
              >
                <div className="font-display font-semibold text-text text-xs mb-1.5">
                  Presence &middot; {highlightedRegions.size} regions
                </div>
                {Object.entries(PRESENCE_OPACITY).map(([type, opacity]) => (
                  <div key={type} className="flex items-center gap-2 mb-0.5">
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ background: '#C4643A', opacity }}
                    />
                    <span className="text-text-secondary capitalize">{type.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Detail sidebar */}
        <AnimatePresence>
          {selectedRegion && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 340, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="border-l border-border bg-bg-raised overflow-y-auto overflow-x-hidden shrink-0"
            >
              <div className="p-5 w-[340px]">
                <button
                  onClick={() => setSelectedRegion(null)}
                  className="float-right text-text-tertiary hover:text-text text-lg leading-none cursor-pointer"
                >
                  &times;
                </button>

                <div className="mb-4">
                  <h2 className="font-display text-2xl font-bold text-text">{selectedRegion.name}</h2>
                  <div className="flex gap-2 mt-2 text-xs text-text-tertiary">
                    {selectedRegion.type && (
                      <span className="bg-bg-subtle px-2 py-0.5 rounded-full capitalize">
                        {selectedRegion.type}
                      </span>
                    )}
                    {selectedRegion.country && (
                      <span className="bg-bg-subtle px-2 py-0.5 rounded-full">
                        {selectedRegion.country}
                      </span>
                    )}
                  </div>
                </div>

                {selectedRegion.strategicImportance && (
                  <div className="mb-4 bg-bg-subtle border-l-2 border-accent rounded-r-lg p-3">
                    <p className="text-xs text-text-secondary leading-relaxed">
                      {selectedRegion.strategicImportance}
                    </p>
                  </div>
                )}

                {selectedRegion.rulingFamily && (() => {
                  const fam = familyNameMap.get(selectedRegion.rulingFamily);
                  return fam ? (
                    <div className="mb-4">
                      <h3 className="font-display font-semibold text-sm text-text-secondary mb-1">Ruling Family</h3>
                      <div className="bg-bg-subtle rounded-lg p-3">
                        <div className="font-display font-semibold text-text">{fam.name}</div>
                        {fam.legitimacyBasis && !fam.legitimacyBasis.includes('UNKNOWN') && (
                          <div className="text-xs text-text-tertiary mt-1 capitalize">
                            Basis: {fam.legitimacyBasis.replace(/_/g, ' ')}
                          </div>
                        )}
                        {fam.description && (
                          <p className="text-xs text-text-tertiary mt-2 line-clamp-3">{fam.description}</p>
                        )}
                      </div>
                    </div>
                  ) : null;
                })()}

                {selectedRegion.dominantTribes.length > 0 && (
                  <div className="mb-4">
                    <h3 className="font-display font-semibold text-sm text-text-secondary mb-2">
                      Dominant Tribes ({selectedRegion.dominantTribes.length})
                    </h3>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {selectedRegion.dominantTribes.map((tId) => {
                        const tribe = tribeNameMap.get(tId);
                        if (!tribe) return null;
                        return (
                          <div key={tId} className="flex items-center gap-2 bg-bg-subtle rounded-lg px-3 py-1.5">
                            {showAlignment && tribe.alignment && tribe.alignment !== 'na' && (
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: ALIGNMENT_COLORS[tribe.alignment] || '#888' }}
                              />
                            )}
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-text truncate block">{tribe.name}</span>
                            </div>
                            {tribe.lineageRoot && (
                              <span className="text-[9px] text-text-tertiary ml-auto shrink-0 capitalize">
                                {tribe.lineageRoot}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {selectedRegion.entities.length > 0 && (
                  <div>
                    <h3 className="font-display font-semibold text-sm text-text-secondary mb-2">
                      All Entities ({selectedRegion.entities.length})
                    </h3>
                    <div className="space-y-1">
                      {selectedRegion.entities.slice(0, 20).map((e) => (
                        <div key={`${e.type}-${e.id}`} className="flex items-center gap-2 text-xs">
                          <span className={`badge-${e.type === 'tribe' ? 'tribe' : e.type === 'family' ? 'family' : 'ethnic'}
                                          text-[9px] px-1.5 py-0.5 rounded-full`}>
                            {e.type}
                          </span>
                          <span className="text-text-secondary truncate">{e.id.replace(/_/g, ' ')}</span>
                          {e.presenceType && (
                            <span className="text-text-tertiary ml-auto text-[9px] capitalize shrink-0">
                              {e.presenceType}
                            </span>
                          )}
                        </div>
                      ))}
                      {selectedRegion.entities.length > 20 && (
                        <div className="text-[10px] text-text-tertiary pt-1">
                          +{selectedRegion.entities.length - 20} more
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="mt-4 pt-3 border-t border-border text-[10px] text-text-tertiary">
                  {selectedRegion.lat?.toFixed(4)}N, {selectedRegion.lng?.toFixed(4)}E
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
