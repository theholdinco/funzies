import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import graphData from '../data/graph.json';
import type { GraphNode, GraphLink } from '../types';

interface Props {
  onSelectEntity?: (type: string, id: string) => void;
}

interface SimNode extends GraphNode, d3.SimulationNodeDatum {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  type: string;
  strength: number;
}

const GROUP_COLORS: Record<string, string> = {
  adnani: '#C4643A',
  qahtani: '#1ABC9C',
  unknown: '#888',
  '<UNKNOWN>': '#888',
  disputed: '#8E44AD',
  family: '#2C3E50',
};

const LINK_DISTANCE: Record<string, number> = {
  sub_tribe: 40,
  family_of: 40,
  alliance: 80,
  shared_migration: 100,
  intermarriage: 90,
  trade_partnership: 100,
  rivalry: 120,
  vassalage: 60,
  claimed_descent: 50,
  offshoot: 50,
};

const INITIAL_NODE_LIMIT = 100;

function getLinkStroke(type: string): string {
  if (type === 'rivalry') return '6,4';
  if (type === 'shared_migration' || type === 'trade_partnership') return '2,4';
  return '';
}

export default function ConnectionsView({ onSelectEntity }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const [showAll, setShowAll] = useState(false);
  const [filterTypes, setFilterTypes] = useState({ tribe: true, family: true });
  const [filterLineage, setFilterLineage] = useState('both');
  const [filterRelationships, setFilterRelationships] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SimNode } | null>(null);

  const allRelTypes = useMemo(() => {
    const types = new Set<string>();
    (graphData.links as GraphLink[]).forEach(l => types.add(l.type));
    return Array.from(types).sort();
  }, []);

  const { nodes, links } = useMemo(() => {
    const rawNodes = (graphData.nodes as GraphNode[])
      .filter(n => {
        if (n.type === 'tribe' && !filterTypes.tribe) return false;
        if (n.type === 'family' && !filterTypes.family) return false;
        if (filterLineage === 'adnani' && n.group !== 'adnani') return false;
        if (filterLineage === 'qahtani' && n.group !== 'qahtani') return false;
        return true;
      })
      .sort((a, b) => b.size - a.size);

    const limited = showAll ? rawNodes : rawNodes.slice(0, INITIAL_NODE_LIMIT);
    const nodeIds = new Set(limited.map(n => n.id));

    const filteredLinks = (graphData.links as GraphLink[]).filter(l => {
      if (!nodeIds.has(l.source) || !nodeIds.has(l.target)) return false;
      if (filterRelationships.size > 0 && !filterRelationships.has(l.type)) return false;
      return true;
    });

    return {
      nodes: limited.map(n => ({ ...n })) as SimNode[],
      links: filteredLinks.map(l => ({ ...l })) as SimLink[],
    };
  }, [showAll, filterTypes, filterLineage, filterRelationships]);

  const searchMatchId = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    const match = nodes.find(n => n.name.toLowerCase().includes(q));
    return match?.id ?? null;
  }, [searchQuery, nodes]);

  const connectedIds = useMemo(() => {
    const activeId = selectedNodeId ?? hoveredNodeId;
    if (!activeId) return null;
    const ids = new Set<string>([activeId]);
    links.forEach(l => {
      const src = typeof l.source === 'object' ? (l.source as SimNode).id : String(l.source);
      const tgt = typeof l.target === 'object' ? (l.target as SimNode).id : String(l.target);
      if (src === activeId) ids.add(tgt);
      if (tgt === activeId) ids.add(src);
    });
    return ids;
  }, [selectedNodeId, hoveredNodeId, links]);

  const nodeRadius = useCallback((d: SimNode) => Math.max(4, Math.sqrt(d.size) * 3), []);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = containerRef.current.getBoundingClientRect();

    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);

    const defs = svg.append('defs');
    defs.append('filter')
      .attr('id', 'glow')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 0)
      .attr('stdDeviation', 4)
      .attr('flood-color', '#C4643A')
      .attr('flood-opacity', 0.8);

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    const simulation = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links)
        .id(d => d.id)
        .distance(d => LINK_DISTANCE[d.type] ?? 80))
      .force('charge', d3.forceManyBody().strength(-60))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<SimNode>().radius(d => nodeRadius(d) + 4));

    simulationRef.current = simulation;

    const linkGroup = g.append('g').attr('class', 'links');
    const linkElements = linkGroup.selectAll<SVGLineElement, SimLink>('line')
      .data(links)
      .join('line')
      .attr('stroke', '#C4643A')
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', d => Math.max(0.5, d.strength * 2))
      .attr('stroke-dasharray', d => getLinkStroke(d.type));

    const nodeGroup = g.append('g').attr('class', 'nodes');
    const nodeElements = nodeGroup.selectAll<SVGCircleElement, SimNode>('circle')
      .data(nodes, d => d.id)
      .join('circle')
      .attr('r', d => nodeRadius(d))
      .attr('fill', d => GROUP_COLORS[d.group] ?? '#888')
      .attr('stroke', '#1a1a2e')
      .attr('stroke-width', 1)
      .style('cursor', 'pointer');

    const labelGroup = g.append('g').attr('class', 'labels');
    const labelElements = labelGroup.selectAll<SVGTextElement, SimNode>('text')
      .data(nodes.filter(n => n.size > 5), d => d.id)
      .join('text')
      .text(d => d.name)
      .attr('font-size', 10)
      .attr('font-family', "'DM Sans', sans-serif")
      .attr('fill', '#E8E8E6')
      .attr('text-anchor', 'middle')
      .attr('dy', d => -nodeRadius(d) - 4)
      .attr('pointer-events', 'none')
      .attr('opacity', 0.8);

    // Drag behavior
    const drag = d3.drag<SVGCircleElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeElements.call(drag);

    // Hover
    nodeElements
      .on('mouseenter', (event, d) => {
        setHoveredNodeId(d.id);
        const [mx, my] = d3.pointer(event, containerRef.current!);
        setTooltip({ x: mx, y: my, node: d });
      })
      .on('mouseleave', () => {
        setHoveredNodeId(null);
        setTooltip(null);
      })
      .on('click', (_event, d) => {
        setSelectedNodeId(prev => prev === d.id ? null : d.id);
        onSelectEntity?.(d.type, d.id);
      });

    simulation.on('tick', () => {
      linkElements
        .attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);

      nodeElements
        .attr('cx', d => d.x!)
        .attr('cy', d => d.y!);

      labelElements
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);
    });

    // Animate links on first load
    linkElements
      .attr('stroke-opacity', 0)
      .transition()
      .duration(1000)
      .delay((_d, i) => i * 2)
      .attr('stroke-opacity', 0.3);

    return () => {
      simulation.stop();
    };
  }, [nodes, links, nodeRadius, onSelectEntity]);

  // Highlight effect based on hover/selection/search
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    const activeHighlight = connectedIds;
    const searchHighlight = searchMatchId;

    svg.selectAll<SVGCircleElement, SimNode>('circle')
      .attr('opacity', d => {
        if (searchHighlight && d.id === searchHighlight) return 1;
        if (activeHighlight && !activeHighlight.has(d.id)) return 0.15;
        return 1;
      })
      .attr('filter', d => {
        if (searchHighlight && d.id === searchHighlight) return 'url(#glow)';
        if (activeHighlight?.has(d.id) && d.id === (selectedNodeId ?? hoveredNodeId)) return 'url(#glow)';
        return 'none';
      })
      .attr('stroke', d => {
        if (searchHighlight && d.id === searchHighlight) return '#C4643A';
        if (d.id === selectedNodeId) return '#C4643A';
        return '#1a1a2e';
      })
      .attr('stroke-width', d => {
        if (d.id === selectedNodeId || (searchHighlight && d.id === searchHighlight)) return 2.5;
        return 1;
      });

    svg.selectAll<SVGLineElement, SimLink>('line')
      .attr('stroke-opacity', d => {
        if (!activeHighlight) return 0.3;
        const src = typeof d.source === 'object' ? (d.source as SimNode).id : String(d.source);
        const tgt = typeof d.target === 'object' ? (d.target as SimNode).id : String(d.target);
        if (activeHighlight.has(src) && activeHighlight.has(tgt)) return 0.7;
        return 0.05;
      });

    svg.selectAll<SVGTextElement, SimNode>('.labels text')
      .attr('opacity', d => {
        if (activeHighlight && !activeHighlight.has(d.id)) return 0.1;
        return 0.8;
      });

    // Pan to search match
    if (searchHighlight) {
      const matchNode = nodes.find(n => n.id === searchHighlight);
      if (matchNode && matchNode.x != null && matchNode.y != null) {
        const { width, height } = containerRef.current!.getBoundingClientRect();
        const transform = d3.zoomIdentity
          .translate(width / 2, height / 2)
          .scale(1.5)
          .translate(-matchNode.x, -matchNode.y);
        svg.transition().duration(600).call(
          d3.zoom<SVGSVGElement, unknown>().transform as any,
          transform,
        );
      }
    }
  }, [connectedIds, searchMatchId, selectedNodeId, hoveredNodeId, nodes]);

  const toggleRelationship = (type: string) => {
    setFilterRelationships(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const resetView = () => {
    setFilterTypes({ tribe: true, family: true });
    setFilterLineage('both');
    setFilterRelationships(new Set());
    setSearchQuery('');
    setSelectedNodeId(null);
    setShowAll(false);
    if (svgRef.current) {
      const svg = d3.select(svgRef.current);
      svg.transition().duration(400).call(
        d3.zoom<SVGSVGElement, unknown>().transform as any,
        d3.zoomIdentity,
      );
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      style={{ height: 'calc(100vh - 4rem)', background: '#1a1a2e' }}
    >
      <svg ref={svgRef} className="absolute inset-0 w-full h-full" />

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 rounded-lg px-3 py-2 text-sm shadow-lg"
          style={{
            left: tooltip.x + 14,
            top: tooltip.y - 10,
            background: 'rgba(26, 26, 46, 0.92)',
            border: '1px solid rgba(196, 100, 58, 0.4)',
            color: '#E8E8E6',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="font-display font-semibold text-accent">{tooltip.node.name}</div>
          <div className="text-xs opacity-70 capitalize">{tooltip.node.type} &middot; {tooltip.node.group}</div>
        </div>
      )}

      {/* Controls Panel */}
      <div
        className="absolute top-4 left-4 z-40 flex flex-col gap-3 rounded-xl p-4 text-sm max-h-[calc(100vh-8rem)] overflow-y-auto"
        style={{
          background: 'rgba(26, 26, 46, 0.75)',
          border: '1px solid rgba(196, 100, 58, 0.25)',
          backdropFilter: 'blur(12px)',
          color: '#E8E8E6',
          width: 220,
        }}
      >
        <h3 className="font-display text-lg font-semibold text-accent">Connections</h3>

        {/* Search */}
        <input
          type="text"
          placeholder="Search node..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="rounded px-2 py-1 text-xs outline-none"
          style={{ background: 'rgba(232, 232, 230, 0.1)', border: '1px solid rgba(196, 100, 58, 0.3)', color: '#E8E8E6' }}
        />

        {/* Filter by type */}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Type</legend>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterTypes.tribe}
              onChange={() => setFilterTypes(p => ({ ...p, tribe: !p.tribe }))}
              className="accent-accent"
            />
            Tribes
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterTypes.family}
              onChange={() => setFilterTypes(p => ({ ...p, family: !p.family }))}
              className="accent-accent"
            />
            Families
          </label>
        </fieldset>

        {/* Filter by lineage */}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Lineage</legend>
          {['both', 'adnani', 'qahtani'].map(val => (
            <label key={val} className="flex items-center gap-2 cursor-pointer capitalize">
              <input
                type="radio"
                name="lineage"
                checked={filterLineage === val}
                onChange={() => setFilterLineage(val)}
                className="accent-accent"
              />
              {val === 'both' ? 'All' : val}
            </label>
          ))}
        </fieldset>

        {/* Filter by relationship */}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Relationship</legend>
          <div className="flex flex-col gap-0.5">
            {allRelTypes.map(t => (
              <label key={t} className="flex items-center gap-2 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={filterRelationships.size === 0 || filterRelationships.has(t)}
                  onChange={() => toggleRelationship(t)}
                  className="accent-accent"
                />
                {t.replace(/_/g, ' ')}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Show all toggle */}
        <label className="flex items-center gap-2 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={showAll}
            onChange={() => setShowAll(p => !p)}
            className="accent-accent"
          />
          Show all nodes ({graphData.nodes.length})
        </label>

        <button
          onClick={resetView}
          className="mt-1 rounded px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer"
          style={{ background: 'rgba(196, 100, 58, 0.25)', border: '1px solid rgba(196, 100, 58, 0.4)', color: '#C4643A' }}
        >
          Reset View
        </button>
      </div>

      {/* Legend */}
      <div
        className="absolute bottom-4 right-4 z-40 rounded-xl p-3 text-xs"
        style={{
          background: 'rgba(26, 26, 46, 0.75)',
          border: '1px solid rgba(196, 100, 58, 0.25)',
          backdropFilter: 'blur(12px)',
          color: '#E8E8E6',
        }}
      >
        <div className="font-semibold mb-2 opacity-70 uppercase tracking-wide">Legend</div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#C4643A' }} />
            Adnani
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#1ABC9C' }} />
            Qahtani
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#2C3E50' }} />
            Families
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#888' }} />
            Unknown
          </div>
          <div className="border-t border-white/10 my-1" />
          <div className="flex items-center gap-2">
            <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="#C4643A" strokeWidth="1.5" /></svg>
            Alliance / Lineage
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="#C4643A" strokeWidth="1.5" strokeDasharray="6,4" /></svg>
            Rivalry
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="#C4643A" strokeWidth="1.5" strokeDasharray="2,4" /></svg>
            Migration / Trade
          </div>
        </div>
      </div>
    </div>
  );
}
