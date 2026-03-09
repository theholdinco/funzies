// --- Core entity types matching JSON data shapes ---

export interface SubTribe {
  id: string;
  name: string;
  nameAr: string | null;
  formationType: string | null;
  legitimacyNotes: string | null;
  ancestorName: string | null;
  ancestorStory: string | null;
  lineageRoot: string | null;
  foundingEra: string | null;
  originRegionId: string | null;
  status: string | null;
  peakPowerEra: string | null;
  traditionalEconomy: string | null;
  alignment: string | null;
  description: string | null;
  color: string | null;
  relationship: string | null;
}

export interface TribalRelation {
  tribeId: string;
  type: string | null;
  strength: string | null;
  context: string | null;
}

export interface Tribe {
  id: string;
  name: string;
  nameAr: string | null;
  formationType: string | null;
  legitimacyNotes: string | null;
  ancestorName: string | null;
  ancestorStory: string | null;
  lineageRoot: string | null;
  foundingEra: string | null;
  originRegionId: string | null;
  status: string | null;
  peakPowerEra: string | null;
  traditionalEconomy: string | null;
  alignment: string | null;
  description: string | null;
  color: string | null;
  subTribes: SubTribe[];
  relations: TribalRelation[];
}

export interface NotableFigure {
  id: string;
  name: string;
  nameAr: string | null;
  familyId: string | null;
  tribeId: string | null;
  bornYear: number | null;
  diedYear: number | null;
  title: string | null;
  roleDescription: string | null;
  era: string | null;
  significance: string | null;
}

export interface Family {
  id: string;
  name: string;
  nameAr: string | null;
  tribeId: string | null;
  familyType: string | null;
  isRuling: number;
  rulesOver: string | null;
  currentHead: string | null;
  foundedYear: number | null;
  originStory: string | null;
  legitimacyBasis: string | null;
  description: string | null;
  notableFigures: NotableFigure[];
}

export interface EthnicGroupRegion {
  regionId: string;
  regionName: string;
  presenceType: string | null;
  influenceLevel: string | null;
}

export interface EthnicGroup {
  id: string;
  name: string;
  nameAr: string | null;
  ethnicity: string | null;
  religion: string | null;
  identityType: string | null;
  preIslamicOrigins: string | null;
  populationEstimate: string | null;
  traditionalEconomy: string | null;
  originNarrative: string | null;
  keyTension: string | null;
  description: string | null;
  regions: EthnicGroupRegion[];
}

export interface RegionEntity {
  type: string;
  id: string;
  presenceType: string | null;
}

export interface Region {
  id: string;
  name: string;
  nameAr: string | null;
  type: string | null;
  country: string | null;
  parentRegionId: string | null;
  lat: number | null;
  lng: number | null;
  boundaryGeojson: string | null;
  strategicImportance: string | null;
  dominantTribes: string[];
  rulingFamily: string | null;
  entities: RegionEntity[];
}

export interface EventParticipant {
  entityType: string;
  entityId: string;
  role: string | null;
  action: string | null;
}

export interface HistoricalEvent {
  id: string;
  title: string;
  titleAr: string | null;
  year: number | null;
  endYear: number | null;
  eventType: string | null;
  locationId: string | null;
  description: string | null;
  significance: string | null;
  outcome: string | null;
  surpriseFactor: string | null;
  participants: EventParticipant[];
}

export interface MigrationPoint {
  regionId: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Migration {
  id: string;
  entityType: string;
  entityId: string;
  waypoints: string | null;
  routeGeojson: string | null;
  startYear: number | null;
  endYear: number | null;
  reason: string | null;
  narrative: string | null;
  populationEstimate: string | null;
  origin: MigrationPoint;
  destination: MigrationPoint;
}

export interface ConnectionEntity {
  entityType: string;
  entityId: string;
}

export interface Connection {
  id: string;
  title: string;
  connectionType: string;
  narrative: string | null;
  insight: string | null;
  entities: ConnectionEntity[];
}

export interface LinkedEntity {
  type: string;
  id: string;
}

export interface NameLookup {
  id: number;
  surname: string;
  surnameAr: string | null;
  originType: string | null;
  meaning: string | null;
  variants: string[];
  funFact: string | null;
  linkedEntity: LinkedEntity | null;
}

// --- Graph types ---

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  group: string;
  color: string | null;
  size: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// --- Timeline types ---

export interface Era {
  id: string;
  label: string;
  startYear: number;
  endYear: number;
  color: string;
}

export interface TimelineData {
  eras: Era[];
  events: HistoricalEvent[];
}

// --- Stats ---

export interface Stats {
  counts: Record<string, number>;
  coverage: Record<string, number>;
  lastUpdated: string;
}

// --- Union types for detail panel ---

export type EntityType = 'tribe' | 'family' | 'figure' | 'ethnic' | 'event' | 'region';

export type Entity =
  | { type: 'tribe'; data: Tribe }
  | { type: 'family'; data: Family }
  | { type: 'figure'; data: NotableFigure }
  | { type: 'ethnic'; data: EthnicGroup }
  | { type: 'event'; data: HistoricalEvent }
  | { type: 'region'; data: Region };

// --- Search result ---

export interface SearchResult {
  type: EntityType;
  id: string;
  name: string;
  nameAr: string | null;
  snippet: string;
  score: number;
}
