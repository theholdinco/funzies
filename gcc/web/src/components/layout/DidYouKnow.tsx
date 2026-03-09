import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';

import tribesData from '../../data/tribes.json';
import eventsData from '../../data/events.json';
import ethnicGroupsData from '../../data/ethnicGroups.json';

interface Fact {
  text: string;
  source: string;
  category: string;
}

function gatherFacts(): Fact[] {
  const facts: Fact[] = [];

  for (const t of tribesData) {
    if (t.description && t.description.length > 60) {
      facts.push({ text: t.description, source: t.name, category: 'Tribe' });
    }
    if (t.ancestorStory) {
      facts.push({ text: t.ancestorStory, source: t.name, category: 'Lineage' });
    }
  }

  for (const e of eventsData) {
    if (e.surpriseFactor) {
      facts.push({ text: e.surpriseFactor, source: e.title, category: 'Event' });
    }
    if (e.significance && e.significance.length > 40) {
      facts.push({ text: e.significance, source: e.title, category: 'History' });
    }
  }

  for (const eg of ethnicGroupsData) {
    if (eg.keyTension) {
      facts.push({ text: eg.keyTension, source: eg.name, category: 'Identity' });
    }
    if (eg.originNarrative && eg.originNarrative.length > 40) {
      facts.push({ text: eg.originNarrative, source: eg.name, category: 'Origins' });
    }
  }

  return facts;
}

export default function DidYouKnow() {
  const [collapsed, setCollapsed] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  const facts = useMemo(() => {
    const all = gatherFacts();
    // Shuffle deterministically based on length
    return all.sort(() => 0.5 - Math.random()).slice(0, 50);
  }, []);

  const nextFact = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % facts.length);
  }, [facts.length]);

  useEffect(() => {
    if (collapsed || facts.length === 0) return;
    const timer = setInterval(nextFact, 15000);
    return () => clearInterval(timer);
  }, [collapsed, nextFact, facts.length]);

  if (facts.length === 0) return null;

  const fact = facts[currentIndex];

  return (
    <div className="hidden lg:block fixed right-6 top-24 w-72 z-30">
      {/* Toggle button */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 mb-2 text-xs font-medium text-accent-hover hover:text-accent transition-colors ml-auto"
      >
        {collapsed ? 'Show' : 'Hide'} Did You Know
        <svg
          className={`w-3.5 h-3.5 transition-transform ${collapsed ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="bg-bg-raised border border-border rounded-xl shadow-sm">
              <div className="relative z-10 p-4">
                {/* Header */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-accent-hover" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                    </svg>
                  </div>
                  <span className="font-display text-sm font-semibold text-text">Did You Know?</span>
                </div>

                {/* Fact content with page-turn animation */}
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentIndex}
                    initial={{ opacity: 0, rotateY: 90 }}
                    animate={{ opacity: 1, rotateY: 0 }}
                    exit={{ opacity: 0, rotateY: -90 }}
                    transition={{ duration: 0.4 }}
                  >
                    <p className="text-xs text-text/80 leading-relaxed line-clamp-6">
                      {fact.text}
                    </p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-accent font-medium">
                        {fact.source}
                      </span>
                      <span className="text-[10px] text-text-tertiary uppercase tracking-wider">
                        {fact.category}
                      </span>
                    </div>
                  </motion.div>
                </AnimatePresence>

                {/* Navigation dots */}
                <div className="flex items-center justify-center gap-1 mt-3">
                  <button
                    onClick={() => setCurrentIndex((prev) => (prev - 1 + facts.length) % facts.length)}
                    className="p-1 text-text-tertiary hover:text-accent transition-colors"
                    aria-label="Previous fact"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                  </button>
                  <span className="text-[10px] text-text-tertiary tabular-nums">
                    {currentIndex + 1} / {facts.length}
                  </span>
                  <button
                    onClick={nextFact}
                    className="p-1 text-text-tertiary hover:text-accent transition-colors"
                    aria-label="Next fact"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
