import { useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import Navbar from './components/layout/Navbar';
import DetailPanel from './components/layout/DetailPanel';
import DidYouKnow from './components/layout/DidYouKnow';
import SearchView from './views/SearchView';
import MapView from './views/MapView';
import TreeView from './views/TreeView';
import TimelineView from './views/TimelineView';
import ConnectionsView from './views/ConnectionsView';
import type { Entity, EntityType } from './types';

import tribesData from './data/tribes.json';
import familiesData from './data/families.json';
import ethnicGroupsData from './data/ethnicGroups.json';
import eventsData from './data/events.json';
import regionsData from './data/regions.json';
import type { Tribe, Family, NotableFigure, EthnicGroup, HistoricalEvent, Region } from './types';

function findEntity(type: EntityType, id: string): Entity | null {
  switch (type) {
    case 'tribe': {
      const item = (tribesData as Tribe[]).find((t) => t.id === id);
      return item ? { type: 'tribe', data: item } : null;
    }
    case 'family': {
      const item = (familiesData as Family[]).find((f) => f.id === id);
      return item ? { type: 'family', data: item } : null;
    }
    case 'figure': {
      for (const fam of familiesData as Family[]) {
        const fig = fam.notableFigures.find((f) => f.id === id);
        if (fig) return { type: 'figure', data: fig as NotableFigure };
      }
      return null;
    }
    case 'ethnic': {
      const item = (ethnicGroupsData as EthnicGroup[]).find((e) => e.id === id);
      return item ? { type: 'ethnic', data: item } : null;
    }
    case 'event': {
      const item = (eventsData as HistoricalEvent[]).find((e) => e.id === id);
      return item ? { type: 'event', data: item } : null;
    }
    case 'region': {
      const item = (regionsData as Region[]).find((r) => r.id === id);
      return item ? { type: 'region', data: item } : null;
    }
    default:
      return null;
  }
}

function AppContent() {
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const handleSelectEntity = useCallback((type: EntityType, id: string) => {
    const entity = findEntity(type, id);
    if (entity) setSelectedEntity(entity);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedEntity(null);
  }, []);

  const isMapView = location.pathname === '/map';

  return (
    <div className="min-h-screen bg-bg">
      <Navbar onSelectEntity={handleSelectEntity} />

      <main className="pt-16">
        <Routes>
          <Route path="/" element={<SearchView onSelectEntity={handleSelectEntity} />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/tree" element={<TreeView />} />
          <Route path="/timeline" element={<TimelineView />} />
          <Route path="/connections" element={<ConnectionsView />} />
          {/* Catch-all: redirect unknown routes to search */}
          <Route path="*" element={<SearchView onSelectEntity={handleSelectEntity} />} />
        </Routes>
      </main>

      <DetailPanel entity={selectedEntity} onClose={handleClosePanel} onNavigate={navigate} />
      {!isMapView && <DidYouKnow />}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
