import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import timelineData from '../data/timeline.json';
import type { TimelineData, HistoricalEvent } from '../types';

interface TimelineViewProps {
  onSelectEntity?: (type: string, id: string) => void;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  political: '#2C3E50',
  military: '#C0392B',
  coup: '#C0392B',
  palace_coup: '#C0392B',
  political_coup: '#C0392B',
  coup_attempt: '#C0392B',
  battle: '#C0392B',
  tribal_battle: '#C0392B',
  military_conflict: '#C0392B',
  military_campaign: '#C0392B',
  military_conquest: '#C0392B',
  military_victory: '#C0392B',
  military_defeat: '#C0392B',
  military_action: '#C0392B',
  military_occupation: '#C0392B',
  military_alliance: '#C0392B',
  conflict: '#C0392B',
  civil_war: '#C0392B',
  war: '#C0392B',
  conquest: '#C0392B',
  rebellion: '#C0392B',
  insurrection: '#C0392B',
  resistance: '#C0392B',
  assassination: '#C0392B',
  treaty: '#C4643A',
  diplomatic_treaty: '#C4643A',
  diplomatic: '#C4643A',
  diplomatic_visit: '#C4643A',
  diplomatic_mission: '#C4643A',
  diplomatic_appointment: '#C4643A',
  political_agreement: '#C4643A',
  founding: '#1ABC9C',
  political_founding: '#1ABC9C',
  administrative_founding: '#1ABC9C',
  institutional_founding: '#1ABC9C',
  organization_founding: '#1ABC9C',
  federation: '#1ABC9C',
  independence: '#1ABC9C',
  establishment: '#1ABC9C',
  discovery: '#8E44AD',
  creative_work: '#8E44AD',
  educational: '#8E44AD',
  cultural: '#8E44AD',
  religious: '#8E44AD',
  religious_reform: '#8E44AD',
};

const EVENT_TYPE_CATEGORIES: Record<string, string> = {
  political: 'Political',
  military: 'Military',
  treaty: 'Treaty / Diplomatic',
  founding: 'Founding',
  discovery: 'Discovery / Cultural',
  other: 'Other',
};

const CATEGORY_COLORS: Record<string, string> = {
  political: '#2C3E50',
  military: '#C0392B',
  treaty: '#C4643A',
  founding: '#1ABC9C',
  discovery: '#8E44AD',
  other: '#7f8c8d',
};

function getEventColor(eventType: string | null): string {
  if (!eventType) return '#7f8c8d';
  return EVENT_TYPE_COLORS[eventType] ?? '#7f8c8d';
}

function getEventCategory(eventType: string | null): string {
  if (!eventType) return 'other';
  if (EVENT_TYPE_COLORS[eventType] === '#2C3E50') return 'political';
  if (EVENT_TYPE_COLORS[eventType] === '#C0392B') return 'military';
  if (EVENT_TYPE_COLORS[eventType] === '#C4643A') return 'treaty';
  if (EVENT_TYPE_COLORS[eventType] === '#1ABC9C') return 'founding';
  if (EVENT_TYPE_COLORS[eventType] === '#8E44AD') return 'discovery';
  return 'other';
}

const MIN_YEAR = 1500;
const MAX_YEAR = 2026;
const ZOOM_LEVELS = [6, 9, 12, 18, 24, 36];

function yearToX(year: number, pixelsPerYear: number): number {
  return (year - MIN_YEAR) * pixelsPerYear;
}

export default function TimelineView({ onSelectEntity }: TimelineViewProps) {
  const data = timelineData as TimelineData;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    new Set(Object.keys(EVENT_TYPE_CATEGORIES))
  );

  const pixelsPerYear = ZOOM_LEVELS[zoomIndex];
  const totalWidth = (MAX_YEAR - MIN_YEAR) * pixelsPerYear;

  const filteredEvents = useMemo(() => {
    return data.events.filter((event) => {
      const year = typeof event.year === 'number' ? event.year : parseInt(String(event.year), 10);
      if (isNaN(year) || year < MIN_YEAR) return false;
      const category = getEventCategory(event.eventType);
      return activeFilters.has(category);
    });
  }, [data.events, activeFilters]);

  const sortedEvents = useMemo(() => {
    return [...filteredEvents].sort((a, b) => {
      const ya = typeof a.year === 'number' ? a.year : parseInt(String(a.year), 10);
      const yb = typeof b.year === 'number' ? b.year : parseInt(String(b.year), 10);
      return ya - yb;
    });
  }, [filteredEvents]);

  const yearMarkers = useMemo(() => {
    const markers: number[] = [];
    const step = pixelsPerYear >= 18 ? 10 : 25;
    for (let y = Math.ceil(MIN_YEAR / step) * step; y <= MAX_YEAR; y += step) {
      markers.push(y);
    }
    return markers;
  }, [pixelsPerYear]);

  const scrollToYear = useCallback(
    (year: number) => {
      if (!scrollRef.current) return;
      const x = yearToX(year, pixelsPerYear);
      scrollRef.current.scrollTo({ left: x - scrollRef.current.clientWidth / 3, behavior: 'smooth' });
    },
    [pixelsPerYear]
  );

  const handleZoomIn = useCallback(() => {
    setZoomIndex((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomIndex((i) => Math.max(i - 1, 0));
  }, []);

  const toggleFilter = useCallback((category: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Controls bar */}
      <div className="bg-bg/90 backdrop-blur-sm border-b border-border px-4 py-3 flex flex-wrap items-center gap-3 z-10">
        {/* Era jump buttons */}
        <div className="flex items-center gap-1.5 mr-4">
          <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider mr-1">Eras</span>
          {data.eras.map((era) => (
            <button
              key={era.id}
              onClick={() => scrollToYear(era.startYear)}
              className="px-2.5 py-1 text-xs font-medium rounded-full transition-all hover:scale-105"
              style={{
                backgroundColor: era.color + '18',
                color: era.color,
                border: `1px solid ${era.color}40`,
              }}
            >
              {era.label}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-border" />

        {/* Event type filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider mr-1">Types</span>
          {Object.entries(EVENT_TYPE_CATEGORIES).map(([key, label]) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              className="px-2.5 py-1 text-xs font-medium rounded-full transition-all"
              style={{
                backgroundColor: activeFilters.has(key) ? CATEGORY_COLORS[key] : 'transparent',
                color: activeFilters.has(key) ? 'white' : CATEGORY_COLORS[key],
                border: `1px solid ${CATEGORY_COLORS[key]}60`,
                opacity: activeFilters.has(key) ? 1 : 0.5,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-border" />

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomOut}
            disabled={zoomIndex === 0}
            className="w-7 h-7 flex items-center justify-center rounded-full border border-border text-text-secondary hover:border-border-strong disabled:opacity-30 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <span className="text-xs text-text-tertiary w-8 text-center">{pixelsPerYear}px</span>
          <button
            onClick={handleZoomIn}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            className="w-7 h-7 flex items-center justify-center rounded-full border border-border text-text-secondary hover:border-border-strong disabled:opacity-30 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* Event count */}
        <span className="text-xs text-text-tertiary ml-auto">
          {sortedEvents.length} events
        </span>
      </div>

      {/* Scrollable timeline area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative"
        style={{ scrollSnapType: 'x proximity' }}
      >
        <div className="relative" style={{ width: totalWidth + 200, minHeight: '100%' }}>
          {/* Era bands at top */}
          <div className="sticky top-0 z-20 bg-bg/95 backdrop-blur-sm border-b border-border">
            <div className="relative h-16">
              {data.eras.map((era, i) => {
                const left = yearToX(Math.max(era.startYear, MIN_YEAR), pixelsPerYear);
                const right = yearToX(Math.min(era.endYear, MAX_YEAR), pixelsPerYear);
                const width = right - left;
                return (
                  <div
                    key={era.id}
                    className="absolute flex items-center px-2 rounded-sm overflow-hidden cursor-pointer transition-opacity hover:opacity-90"
                    style={{
                      left: left + 60,
                      width,
                      top: (i % 3) * 20 + 2,
                      height: 18,
                      backgroundColor: era.color + '25',
                      borderLeft: `3px solid ${era.color}`,
                      scrollSnapAlign: 'start',
                    }}
                    onClick={() => scrollToYear(era.startYear)}
                  >
                    <span
                      className="text-[10px] font-medium truncate whitespace-nowrap"
                      style={{ color: era.color }}
                    >
                      {era.label} ({era.startYear}&#8211;{era.endYear})
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Timeline axis and content */}
          <div className="relative" style={{ paddingTop: 20 }}>
            {/* Central axis line */}
            <div
              className="absolute left-[60px] right-0"
              style={{
                top: 280,
                height: 3,
                background: 'linear-gradient(to right, #C4643A, #D4876A, #C4643A)',
                borderRadius: 2,
              }}
            />

            {/* Decorative endpoints */}
            <div
              className="absolute rounded-full"
              style={{
                left: 54,
                top: 275,
                width: 12,
                height: 12,
                backgroundColor: '#C4643A',
                border: '2px solid #A84E2E',
              }}
            />
            <div
              className="absolute rounded-full"
              style={{
                left: totalWidth + 60,
                top: 275,
                width: 12,
                height: 12,
                backgroundColor: '#C4643A',
                border: '2px solid #A84E2E',
              }}
            />

            {/* Year markers */}
            {yearMarkers.map((year) => {
              const x = yearToX(year, pixelsPerYear) + 60;
              return (
                <div key={year} className="absolute" style={{ left: x }}>
                  {/* Marker dot */}
                  <div
                    className="absolute rounded-full"
                    style={{
                      left: -4,
                      top: 277,
                      width: 8,
                      height: 8,
                      backgroundColor: '#C4643A',
                    }}
                  />
                  {/* Year label */}
                  <span
                    className="absolute text-[10px] text-accent-hover font-medium"
                    style={{ left: -16, top: 292, width: 40, textAlign: 'center' }}
                  >
                    {year}
                  </span>
                </div>
              );
            })}

            {/* Event cards */}
            {sortedEvents.map((event, index) => {
              const year = typeof event.year === 'number'
                ? event.year
                : parseInt(String(event.year), 10);
              const x = yearToX(year, pixelsPerYear) + 60;
              const isAbove = index % 2 === 0;
              const color = getEventColor(event.eventType);
              const isExpanded = expandedEventId === event.id;

              return (
                <EventCard
                  key={event.id}
                  event={event}
                  x={x}
                  isAbove={isAbove}
                  color={color}
                  isExpanded={isExpanded}
                  onToggle={() =>
                    setExpandedEventId(isExpanded ? null : event.id)
                  }
                  onSelectEntity={onSelectEntity}
                />
              );
            })}

            {/* Bottom padding */}
            <div style={{ height: 340 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

interface EventCardProps {
  event: HistoricalEvent;
  x: number;
  isAbove: boolean;
  color: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSelectEntity?: (type: string, id: string) => void;
}

function EventCard({
  event,
  x,
  isAbove,
  color,
  isExpanded,
  onToggle,
  onSelectEntity,
}: EventCardProps) {
  const year = typeof event.year === 'number'
    ? event.year
    : parseInt(String(event.year), 10);
  const category = getEventCategory(event.eventType);
  const categoryLabel = EVENT_TYPE_CATEGORIES[category] ?? 'Other';

  return (
    <div
      className="absolute"
      style={{
        left: x - 80,
        top: isAbove ? 20 : 310,
        width: 160,
        zIndex: isExpanded ? 30 : 10,
      }}
    >
      {/* Connector line from card to axis */}
      <div
        className="absolute left-[80px] w-px"
        style={{
          backgroundColor: color + '40',
          top: isAbove ? '100%' : undefined,
          bottom: isAbove ? undefined : '100%',
          height: isAbove ? 280 - 240 : 20,
        }}
      />

      {/* Card */}
      <motion.div
        layout
        onClick={onToggle}
        className="relative bg-white rounded-lg cursor-pointer overflow-hidden"
        style={{
          borderLeft: `3px solid ${color}`,
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        }}
        whileHover={{
          y: isAbove ? -2 : 2,
          boxShadow: `0 4px 16px rgba(0,0,0,0.1), 0 0 0 1px ${color}20`,
        }}
        transition={{ duration: 0.2 }}
      >
        <div className="p-2.5">
          {/* Title */}
          <h3
            className="font-display text-sm font-semibold leading-tight text-text"
            style={{ lineHeight: '1.2' }}
          >
            {event.title}
          </h3>

          {/* Year badge + type pill */}
          <div className="flex items-center gap-1.5 mt-1.5">
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: color + '15', color }}
            >
              {year}
            </span>
            <span
              className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: color + '12', color: color + 'cc' }}
            >
              {categoryLabel}
            </span>
          </div>

          {/* Description (truncated) */}
          {event.description && !isExpanded && (
            <p className="text-[11px] text-text-secondary mt-1.5 leading-snug line-clamp-2">
              {event.description}
            </p>
          )}

          {/* Participants count */}
          {event.participants.length > 0 && !isExpanded && (
            <span className="text-[10px] text-text-tertiary mt-1 inline-block">
              {event.participants.length} participant{event.participants.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Expanded content */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div className="px-2.5 pb-2.5 border-t border-border pt-2">
                {/* Full description */}
                {event.description && (
                  <p className="text-[11px] text-text-secondary leading-relaxed mb-2">
                    {event.description}
                  </p>
                )}

                {/* Significance quote */}
                {event.significance && (
                  <blockquote
                    className="text-[11px] italic text-text-tertiary border-l-2 pl-2 mb-2"
                    style={{ borderColor: color + '40' }}
                  >
                    {event.significance}
                  </blockquote>
                )}

                {/* Outcome */}
                {event.outcome && (
                  <p className="text-[11px] text-text-secondary mb-2">
                    <span className="font-semibold">Outcome:</span> {event.outcome}
                  </p>
                )}

                {/* Participants */}
                {event.participants.length > 0 && (
                  <div className="mt-1.5">
                    <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                      Participants
                    </span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {event.participants.map((p, i) => (
                        <button
                          key={i}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectEntity?.(p.entityType, p.entityId);
                          }}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-subtle text-text-secondary hover:bg-bg transition-colors"
                          title={p.role ?? undefined}
                        >
                          {p.entityId.replace(/_/g, ' ')}
                          {p.role && (
                            <span className="text-text-tertiary ml-0.5">({p.role})</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
