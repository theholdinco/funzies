import { useRef, useEffect, useState, useMemo } from 'react';
import * as d3 from 'd3';
import tribesData from '../data/tribes.json';
import familiesData from '../data/families.json';
import type { Tribe, Family } from '../types';

interface TreeViewProps {
  onSelectEntity?: (type: string, id: string) => void;
}

interface TreeNode {
  id: string;
  name: string;
  nodeType: 'root' | 'lineage' | 'tribe' | 'sub-tribe' | 'family';
  lineage: 'adnani' | 'qahtani' | 'unknown';
  isRuling?: boolean;
  rulesOver?: string | null;
  entityType?: string;
  entityId?: string;
  children?: TreeNode[];
  _children?: TreeNode[];
}

type HNode = d3.HierarchyPointNode<TreeNode>;
type HLink = d3.HierarchyPointLink<TreeNode>;

const COLORS = {
  bg: '#FAFAF8',
  text: '#1A1A1A',
  accent: '#C4643A',
  highlight: '#E74C3C',
  adnani: { node: '#FFF8F5', border: '#C4643A', link: '#C4643A' },
  qahtani: { node: '#EFF8F6', border: '#5BA89D', link: '#5BA89D' },
  unknown: { node: '#F0EEF5', border: '#8E8BA8', link: '#8E8BA8' },
};

const NODE_W = 180;
const NODE_H = 46;
const TRANSITION_MS = 500;

function buildTreeData(showFamilies: boolean): TreeNode {
  const tribes = tribesData as Tribe[];
  const families = familiesData as Family[];

  const familyByTribe = new Map<string, Family[]>();
  if (showFamilies) {
    for (const fam of families) {
      if (fam.tribeId && fam.tribeId !== '<UNKNOWN>' && fam.tribeId !== 'null') {
        const list = familyByTribe.get(fam.tribeId) || [];
        list.push(fam);
        familyByTribe.set(fam.tribeId, list);
      }
    }
  }

  const groups: Record<string, Tribe[]> = { adnani: [], qahtani: [], unknown: [] };
  for (const tribe of tribes) {
    const lr = tribe.lineageRoot;
    if (lr === 'adnani') groups.adnani.push(tribe);
    else if (lr === 'qahtani') groups.qahtani.push(tribe);
    else groups.unknown.push(tribe);
  }

  function tribeNode(tribe: Tribe, lineage: 'adnani' | 'qahtani' | 'unknown'): TreeNode {
    const ch: TreeNode[] = [];
    for (const sub of tribe.subTribes) {
      const sl = (sub.lineageRoot === 'adnani' || sub.lineageRoot === 'qahtani') ? sub.lineageRoot : lineage;
      ch.push({ id: sub.id, name: sub.name, nodeType: 'sub-tribe', lineage: sl, entityType: 'tribe', entityId: sub.id });
    }
    for (const fam of familyByTribe.get(tribe.id) || []) {
      ch.push({ id: fam.id, name: fam.name, nodeType: 'family', lineage, isRuling: fam.isRuling === 1, rulesOver: fam.rulesOver, entityType: 'family', entityId: fam.id });
    }
    return { id: tribe.id, name: tribe.name, nodeType: 'tribe', lineage, entityType: 'tribe', entityId: tribe.id, children: ch.length > 0 ? ch : undefined };
  }

  function lineageNode(id: string, name: string, lineage: 'adnani' | 'qahtani' | 'unknown', list: Tribe[]): TreeNode {
    return { id, name, nodeType: 'lineage', lineage, children: list.map(t => tribeNode(t, lineage)) };
  }

  const rootCh: TreeNode[] = [
    lineageNode('adnani', 'Adnanites', 'adnani', groups.adnani),
    lineageNode('qahtani', 'Qahtanites', 'qahtani', groups.qahtani),
  ];
  if (groups.unknown.length > 0) {
    rootCh.push(lineageNode('unknown', 'Other / Unknown', 'unknown', groups.unknown));
  }

  return { id: 'root', name: 'Arabian Tribes', nodeType: 'root', lineage: 'adnani', children: rootCh };
}

function colorsFor(node: TreeNode) {
  return COLORS[node.lineage] || COLORS.unknown;
}

function typeIcon(nodeType: string): string {
  switch (nodeType) {
    case 'root': return '\u{1F333}';
    case 'lineage': return '\u{1F3DB}';
    case 'tribe': return '\u2694';
    case 'sub-tribe': return '\u{1F3D5}';
    case 'family': return '\u{1F451}';
    default: return '';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

function tooltipText(d: TreeNode): string {
  const parts = [d.name];
  if (d.isRuling && d.rulesOver) parts.push(`Rules: ${d.rulesOver}`);
  const cc = (d.children?.length || 0) + (d._children?.length || 0);
  if (cc > 0) parts.push(`${cc} branches`);
  return parts.join(' \u00B7 ');
}

function collapseDeep(node: TreeNode, depth: number) {
  if (depth >= 2 && node.children) {
    node._children = node.children;
    node.children = undefined;
  }
  for (const c of node.children || []) collapseDeep(c, depth + 1);
  for (const c of node._children || []) collapseDeep(c, depth + 1);
}

export default function TreeView({ onSelectEntity }: TreeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const renderedRef = useRef(false);
  const updateFnRef = useRef<((source: HNode) => void) | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const treeDataRef = useRef<TreeNode | null>(null);

  const [showFamilies, setShowFamilies] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const freshData = useMemo(() => buildTreeData(showFamilies), [showFamilies]);

  // On data change (showFamilies toggle), reset tree
  useEffect(() => {
    renderedRef.current = false;
  }, [freshData]);

  useEffect(() => {
    const svgEl = svgRef.current;
    const container = containerRef.current;
    if (!svgEl || !container) return;
    if (renderedRef.current) return;
    renderedRef.current = true;

    const data = structuredClone(freshData);
    collapseDeep(data, 0);
    treeDataRef.current = data;

    const width = container.clientWidth;
    const height = container.clientHeight;
    const svg = d3.select(svgEl);
    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const g = svg.append('g').attr('class', 'tree-root');

    // Tooltip
    const tipG = g.append('g').attr('class', 'tip').attr('opacity', 0).attr('pointer-events', 'none');
    tipG.append('rect').attr('rx', 4).attr('fill', COLORS.text).attr('opacity', 0.9);
    tipG.append('text').attr('text-anchor', 'middle').attr('font-family', "'DM Sans', sans-serif").attr('font-size', '11px').attr('fill', '#fff');

    const linkGroup = g.append('g').attr('class', 'links');
    const nodeGroup = g.append('g').attr('class', 'nodes');

    const treeLayout = d3.tree<TreeNode>().nodeSize([34, 280]).separation((a, b) => a.parent === b.parent ? 1 : 1.3);

    let selectedId: string | null = null;

    function update(source: HNode) {
      const root = d3.hierarchy(data);
      const laid = treeLayout(root);
      const nodes = laid.descendants();
      const links = laid.links();

      // Assign persistent unique ids for key function
      const nodeId = (d: HNode) => d.data.id;
      const linkId = (d: HLink) => d.source.data.id + '>' + d.target.data.id;

      // --- LINKS ---
      const linkSel = linkGroup.selectAll<SVGPathElement, HLink>('path').data(links, d => linkId(d));

      const linkPath = (d: HLink) =>
        `M${d.source.y},${d.source.x}C${(d.source.y + d.target.y) / 2},${d.source.x} ${(d.source.y + d.target.y) / 2},${d.target.x} ${d.target.y},${d.target.x}`;

      linkSel.enter()
        .append('path')
        .attr('fill', 'none')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0)
        .attr('d', linkPath)
        .attr('stroke', d => colorsFor(d.target.data).link)
        .transition().duration(TRANSITION_MS)
        .attr('opacity', 0.45);

      linkSel.transition().duration(TRANSITION_MS)
        .attr('d', linkPath)
        .attr('stroke', d => colorsFor(d.target.data).link)
        .attr('opacity', 0.45);

      linkSel.exit().transition().duration(TRANSITION_MS).attr('opacity', 0).remove();

      // --- NODES ---
      const nodeSel = nodeGroup.selectAll<SVGGElement, HNode>('g.node').data(nodes, d => nodeId(d));

      const entering = nodeSel.enter()
        .append('g')
        .attr('class', 'node')
        .attr('transform', `translate(${source.y},${source.x})`)
        .attr('opacity', 0)
        .style('cursor', 'pointer');

      // Card background
      entering.append('rect').attr('class', 'bg')
        .attr('x', -NODE_W / 2).attr('y', -NODE_H / 2)
        .attr('width', NODE_W).attr('height', NODE_H)
        .attr('rx', 8).attr('ry', 8)
        .style('filter', 'drop-shadow(0px 2px 4px rgba(0,0,0,0.08))');

      // Type icon
      entering.append('text').attr('class', 'icon')
        .attr('x', -NODE_W / 2 + 10).attr('y', 1)
        .attr('font-size', '13px').attr('dominant-baseline', 'central');

      // Name label
      entering.append('text').attr('class', 'label')
        .attr('x', -NODE_W / 2 + 28).attr('y', 4)
        .attr('font-family', "'DM Sans', sans-serif")
        .attr('font-size', '12.5px').attr('font-weight', 600).attr('fill', COLORS.text);

      // Crown badge
      entering.append('text').attr('class', 'crown')
        .attr('x', NODE_W / 2 - 18).attr('y', -NODE_H / 2 + 15)
        .attr('font-size', '11px').attr('text-anchor', 'middle');

      // Toggle circle
      entering.append('circle').attr('class', 'toggle')
        .attr('cx', NODE_W / 2).attr('cy', 0).attr('r', 8)
        .attr('fill', COLORS.bg).attr('stroke', COLORS.accent).attr('stroke-width', 1.5);

      // Toggle text
      entering.append('text').attr('class', 'toggle-t')
        .attr('x', NODE_W / 2).attr('y', 1)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('font-family', "'DM Sans', sans-serif").attr('font-size', '11px')
        .attr('font-weight', 700).attr('fill', COLORS.text).attr('pointer-events', 'none');

      // Interaction
      entering
        .on('mouseenter', function (_ev, d) {
          d3.select(this).select('.bg').transition().duration(150)
            .style('filter', `drop-shadow(0px 0px 8px ${colorsFor(d.data).border}55)`);
          const txt = tooltipText(d.data);
          const tipText = tipG.select('text').text(txt);
          const bbox = (tipText.node() as SVGTextElement).getBBox();
          tipG.select('rect')
            .attr('x', -bbox.width / 2 - 8).attr('y', -bbox.height - 6)
            .attr('width', bbox.width + 16).attr('height', bbox.height + 8);
          tipG.attr('transform', `translate(${d.y},${d.x - NODE_H / 2 - 10})`).attr('opacity', 1);
        })
        .on('mouseleave', function () {
          d3.select(this).select('.bg').transition().duration(150)
            .style('filter', 'drop-shadow(0px 2px 4px rgba(0,0,0,0.08))');
          tipG.attr('opacity', 0);
        })
        .on('click', function (ev, d) {
          ev.stopPropagation();
          const nd = d.data;
          if (nd._children) { nd.children = nd._children; nd._children = undefined; }
          else if (nd.children) { nd._children = nd.children; nd.children = undefined; }
          selectedId = nd.id;
          update(d);
        })
        .on('dblclick', function (ev, d) {
          ev.stopPropagation();
          if (d.data.entityType && d.data.entityId && onSelectEntity) {
            onSelectEntity(d.data.entityType, d.data.entityId);
          }
        });

      // Merge
      const merged = entering.merge(nodeSel);

      merged.transition().duration(TRANSITION_MS)
        .attr('transform', d => `translate(${d.y},${d.x})`)
        .attr('opacity', 1);

      merged.select<SVGRectElement>('.bg')
        .attr('fill', d => colorsFor(d.data).node)
        .attr('stroke', d => d.data.id === selectedId ? COLORS.accent : colorsFor(d.data).border)
        .attr('stroke-width', d => d.data.id === selectedId ? 3 : 1.5);

      merged.select('.icon').text(d => typeIcon(d.data.nodeType));
      merged.select('.label').text(d => truncate(d.data.name, 20));
      merged.select('.crown').text(d => d.data.isRuling ? '\u{1F451}' : '');

      const hasKids = (d: HNode) => !!(d.data.children || d.data._children);
      merged.select('.toggle').attr('opacity', d => hasKids(d) ? 1 : 0);
      merged.select('.toggle-t')
        .text(d => d.data._children ? '+' : d.data.children ? '\u2212' : '')
        .attr('opacity', d => hasKids(d) ? 1 : 0);

      // Exit
      nodeSel.exit().transition().duration(TRANSITION_MS)
        .attr('transform', `translate(${source.y},${source.x})`)
        .attr('opacity', 0).remove();
    }

    updateFnRef.current = update;

    // Initial render
    const initRoot = treeLayout(d3.hierarchy(data));
    update(initRoot);

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on('zoom', (ev) => { g.attr('transform', ev.transform); });

    zoomBehaviorRef.current = zoom;
    svg.call(zoom as unknown as (sel: d3.Selection<SVGSVGElement, unknown, null, undefined>) => void);

    const t0 = d3.zoomIdentity.translate(width * 0.1, height / 2).scale(0.7);
    svg.call(zoom.transform as unknown as (sel: d3.Selection<SVGSVGElement, unknown, null, undefined>, ...args: unknown[]) => void, t0);

    // Resize
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      svg.attr('width', w).attr('height', h);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [freshData, onSelectEntity]);

  // Search effect
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomBehaviorRef.current) return;

    const g = d3.select(svgEl).select('g.tree-root').select('g.nodes');
    const lower = searchTerm.toLowerCase();
    let navigated = false;

    g.selectAll<SVGGElement, HNode>('g.node').each(function (d) {
      const match = lower.length > 1 && d.data.name.toLowerCase().includes(lower);

      d3.select(this).select('.bg')
        .transition().duration(250)
        .attr('stroke', match ? COLORS.highlight : colorsFor(d.data).border)
        .attr('stroke-width', match ? 3 : 1.5);

      if (match && !navigated && lower.length > 2) {
        navigated = true;
        const container = containerRef.current;
        if (container) {
          const t = d3.zoomIdentity.translate(container.clientWidth / 2 - d.y, container.clientHeight / 2 - d.x).scale(1);
          d3.select(svgEl).transition().duration(500)
            .call(zoomBehaviorRef.current!.transform as unknown as (sel: d3.Transition<SVGSVGElement, unknown, null, undefined>, ...args: unknown[]) => void, t);
        }
      }
    });
  }, [searchTerm]);

  function handleZoom(factor: number) {
    const el = svgRef.current;
    if (!el || !zoomBehaviorRef.current) return;
    d3.select(el).transition().duration(250)
      .call(zoomBehaviorRef.current.scaleBy as unknown as (sel: d3.Transition<SVGSVGElement, unknown, null, undefined>, ...args: unknown[]) => void, factor);
  }

  function handleResetZoom() {
    const el = svgRef.current;
    const c = containerRef.current;
    if (!el || !c || !zoomBehaviorRef.current) return;
    const t = d3.zoomIdentity.translate(c.clientWidth * 0.1, c.clientHeight / 2).scale(0.7);
    d3.select(el).transition().duration(400)
      .call(zoomBehaviorRef.current.transform as unknown as (sel: d3.Transition<SVGSVGElement, unknown, null, undefined>, ...args: unknown[]) => void, t);
  }

  return (
    <div className="relative w-full" style={{ height: 'calc(100vh - 4rem)' }}>
      {/* Background with grid */}
      <div className="absolute inset-0 bg-bg" style={{
        backgroundImage: 'linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />

      {/* Zoom controls - top left */}
      <div className="absolute top-4 left-4 z-10 flex flex-col rounded-lg shadow-md overflow-hidden bg-bg-subtle border border-border">
        <button onClick={() => handleZoom(1.4)} className="px-3 py-2 text-lg font-bold text-text hover:bg-bg transition-colors" title="Zoom in">+</button>
        <div className="h-px bg-border" />
        <button onClick={() => handleZoom(0.7)} className="px-3 py-2 text-lg font-bold text-text hover:bg-bg transition-colors" title="Zoom out">{'\u2212'}</button>
        <div className="h-px bg-border" />
        <button onClick={handleResetZoom} className="px-3 py-2 text-xs font-semibold text-text hover:bg-bg transition-colors" style={{ fontFamily: "'DM Sans', sans-serif" }} title="Reset view">Reset</button>
      </div>

      {/* Search + toggle - top right */}
      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 items-end">
        <input
          type="text"
          placeholder="Find in tree\u2026"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="px-3 py-2 rounded-lg shadow-md border border-border outline-none text-sm w-56 bg-bg-subtle text-text"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        />
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg shadow-md text-sm cursor-pointer bg-bg-subtle border border-border text-text" style={{ fontFamily: "'DM Sans', sans-serif" }}>
          <input type="checkbox" checked={showFamilies} onChange={e => setShowFamilies(e.target.checked)} className="accent-accent" />
          Show families
        </label>
      </div>

      {/* Legend - bottom right */}
      <div className="absolute bottom-4 right-4 z-10 rounded-xl shadow-md px-4 py-3 bg-bg-raised/90 backdrop-blur border border-border" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div className="text-xs font-semibold mb-2 text-text">Legend</div>
        <div className="flex flex-col gap-1.5 text-xs text-text">
          <LegendItem color={COLORS.adnani.border} label="Adnanite lineage" />
          <LegendItem color={COLORS.qahtani.border} label="Qahtanite lineage" />
          <LegendItem color={COLORS.unknown.border} label="Unknown / Other" />
          <div className="mt-1 border-t pt-1 border-border">
            <span>{'\u{1F3DB}'} Lineage</span>{' \u00B7 '}<span>{'\u2694'} Tribe</span>{' \u00B7 '}<span>{'\u{1F3D5}'} Sub-tribe</span>{' \u00B7 '}<span>{'\u{1F451}'} Family</span>
          </div>
          <div className="text-[10px] text-text-tertiary mt-1">Click to expand/collapse {'\u00B7'} Double-click for details</div>
        </div>
      </div>

      {/* SVG canvas */}
      <div ref={containerRef} className="absolute inset-0">
        <svg ref={svgRef} className="w-full h-full" />
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}
