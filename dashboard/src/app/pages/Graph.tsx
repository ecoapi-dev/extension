import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import { Share2, X, ExternalLink, Loader2, ChevronDown } from 'lucide-react';
import { useGraph } from '@/lib/queries';
import type { GraphNode as GNode, GraphEdge, EndpointStatus } from '@/lib/types';

const statusColors: Record<EndpointStatus | string, string> = {
  'normal': '#4EAA57',
  'cacheable': '#7EA87E',
  'batchable': '#5CBF65',
  'redundant': '#B8A038',
  'n_plus_one_risk': '#C87F3A',
  'rate_limit_risk': '#C45A4A',
};

const statusLabels: Record<string, string> = {
  'normal': 'normal',
  'cacheable': 'cacheable',
  'batchable': 'batchable',
  'redundant': 'redundant',
  'n_plus_one_risk': 'n+1 risk',
  'rate_limit_risk': 'rate limit',
};

interface PositionedNode {
  id: string;
  type: 'file' | 'api';
  label: string;
  status?: EndpointStatus;
  provider?: string;
  monthlyCost?: number;
  method?: string;
  x: number;
  y: number;
}

export default function Graph() {
  const { projectId } = useParams<{ projectId: string }>();
  const [clusterBy, setClusterBy] = useState<string>('provider');
  const { data, isLoading } = useGraph(projectId, clusterBy);

  const graphData = data?.data;
  const nodes = graphData?.nodes ?? [];
  const edges = graphData?.edges ?? [];

  // Position nodes: files on left, api nodes on right
  const positioned = useMemo(() => {
    const fileSet = new Set(edges.map((e) => e.source));
    const files = [...fileSet];
    const result: PositionedNode[] = [];

    files.forEach((f, i) => {
      result.push({
        id: f,
        type: 'file',
        label: f.split('/').pop() ?? f,
        x: 100,
        y: 80 + i * 80,
      });
    });

    nodes.forEach((n, i) => {
      const method = n.label.split(' ')[0] ?? '';
      const url = n.label.split(' ').slice(1).join(' ') || n.label;
      result.push({
        id: n.id,
        type: 'api',
        label: url,
        status: n.status,
        provider: n.provider,
        monthlyCost: n.monthlyCost,
        method,
        x: 440,
        y: 60 + i * 100,
      });
    });

    return result;
  }, [nodes, edges]);

  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [pan, setPan] = useState({ x: 40, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.graph-node')) return;
    setDragging(true);
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan((p) => ({
      x: p.x + (e.clientX - lastPos.current.x),
      y: p.y + (e.clientY - lastPos.current.y),
    }));
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, [dragging]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  useEffect(() => {
    const handleGlobalUp = () => setDragging(false);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => window.removeEventListener('mouseup', handleGlobalUp);
  }, []);

  const getNodeCenter = (node: PositionedNode) => {
    if (node.type === 'file') return { x: node.x + 65, y: node.y + 16 };
    return { x: node.x + 22, y: node.y + 22 };
  };

  const svgHeight = Math.max(800, positioned.length * 90);
  const svgWidth = 700;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-[#4EAA57]" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-[18px] text-[#D6EDD0] flex items-center gap-2">
            <Share2 size={16} className="text-[#4EAA57]" />
            Dependency Graph
          </h1>
          <p className="text-[12px] text-[#7EA87E] mt-1">
            File &rarr; API endpoint relationships · {nodes.length} endpoints · Click a node for details
          </p>
        </div>
        <div className="relative">
          <select
            value={clusterBy}
            onChange={(e) => setClusterBy(e.target.value)}
            className="appearance-none bg-[#131A13] border border-[#243224] rounded-lg px-3 py-1.5 pr-8 text-[11px] text-[#D6EDD0] focus:outline-none focus:border-[#4EAA57]/40 cursor-pointer"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="provider">Group by Provider</option>
            <option value="file">Group by File</option>
            <option value="cost">Group by Cost</option>
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#7EA87E] pointer-events-none" />
        </div>
      </div>

      {nodes.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-[#7EA87E]">
          <p className="text-[12px]">No graph data. Run a scan first.</p>
        </div>
      )}

      {nodes.length > 0 && (
        <div
          className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{ background: 'radial-gradient(circle at 50% 30%, #131A1380 0%, #0B0F0B 70%)' }}
        >
          {/* Grid pattern */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-[0.06]">
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#4EAA57" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>

          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            {/* Edges */}
            <svg className="absolute inset-0 pointer-events-none" width={svgWidth} height={svgHeight}>
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#4EAA57" opacity="0.4" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const fromNode = positioned.find((n) => n.id === edge.source);
                const toNode = positioned.find((n) => n.id === edge.target);
                if (!fromNode || !toNode) return null;
                const from = getNodeCenter(fromNode);
                const to = getNodeCenter(toNode);
                const isHighlighted = selected && (selected.id === edge.source || selected.id === edge.target);
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${edge.line}`}
                    x1={from.x} y1={from.y}
                    x2={to.x} y2={to.y}
                    stroke={isHighlighted ? '#4EAA57' : '#243224'}
                    strokeWidth={isHighlighted ? 1.5 : 1}
                    opacity={isHighlighted ? 0.8 : 0.5}
                    markerEnd="url(#arrowhead)"
                  />
                );
              })}
            </svg>

            {/* Nodes */}
            {positioned.map((node) => {
              const isSelected = selected?.id === node.id;
              const isConnected = selected && edges.some(
                (e) => (e.source === selected.id && e.target === node.id) || (e.target === selected.id && e.source === node.id)
              );
              const dimmed = selected && !isSelected && !isConnected;

              if (node.type === 'file') {
                return (
                  <div
                    key={node.id}
                    className="graph-node absolute cursor-pointer transition-all duration-200"
                    style={{ left: node.x, top: node.y, opacity: dimmed ? 0.3 : 1 }}
                    onClick={() => setSelected(isSelected ? null : node)}
                  >
                    <div className={`px-3 py-1.5 rounded-md border text-[11px] transition-colors ${isSelected ? 'bg-[#1C271C] border-[#4EAA57]/50 text-[#D6EDD0]' : 'bg-[#131A13] border-[#243224] text-[#7EA87E] hover:border-[#4EAA57]/30'}`}>
                      {node.label}
                    </div>
                  </div>
                );
              }

              const color = statusColors[node.status ?? 'normal'] || '#4EAA57';
              return (
                <div
                  key={node.id}
                  className="graph-node absolute cursor-pointer transition-all duration-200"
                  style={{ left: node.x, top: node.y, opacity: dimmed ? 0.3 : 1 }}
                  onClick={() => setSelected(isSelected ? null : node)}
                >
                  <div
                    className={`w-11 h-11 rounded-full border-2 flex items-center justify-center text-[9px] transition-colors ${isSelected ? 'shadow-lg' : ''}`}
                    style={{
                      borderColor: isSelected ? color : `${color}60`,
                      backgroundColor: `${color}15`,
                      boxShadow: isSelected ? `0 0 12px ${color}30` : 'none',
                      color,
                    }}
                  >
                    {(node.method ?? '').slice(0, 3)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Info Card */}
          {selected && (
            <div className="absolute top-4 right-4 w-64 bg-[#131A13] border border-[#243224] rounded-xl p-4 shadow-xl z-20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] text-[#7EA87E] uppercase tracking-wider">
                  {selected.type === 'file' ? 'File' : 'API Endpoint'}
                </span>
                <button onClick={() => setSelected(null)} className="text-[#7EA87E] hover:text-[#D6EDD0]">
                  <X size={14} />
                </button>
              </div>
              {selected.type === 'file' ? (
                <>
                  <p className="text-[13px] text-[#D6EDD0] mb-2">{selected.label}</p>
                  <p className="text-[10px] text-[#7EA87E]">
                    {edges.filter((e) => e.source === selected.id).length} outgoing API calls
                  </p>
                </>
              ) : (
                <>
                  <code className="text-[12px] text-[#D6EDD0] block mb-2">{selected.label}</code>
                  <div className="space-y-1.5 text-[10px]">
                    <div className="flex justify-between">
                      <span className="text-[#7EA87E]">Method</span>
                      <span className="text-[#D6EDD0]">{selected.method}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#7EA87E]">Provider</span>
                      <span className="text-[#D6EDD0] capitalize">{selected.provider}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#7EA87E]">Status</span>
                      <span style={{ color: statusColors[selected.status ?? 'normal'] }}>
                        {statusLabels[selected.status ?? 'normal'] ?? selected.status}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#7EA87E]">Monthly Cost</span>
                      <span className="text-[#D6EDD0]">${selected.monthlyCost?.toFixed(2)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-[#131A13]/90 border border-[#243224] rounded-lg px-3 py-2 backdrop-blur-sm">
            <div className="flex items-center gap-4 text-[9px] text-[#7EA87E]">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-2 rounded-sm bg-[#131A13] border border-[#243224]" /> File
              </div>
              {Object.entries(statusColors).map(([status, color]) => (
                <div key={status} className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: `${color}60`, border: `1px solid ${color}` }} />
                  {statusLabels[status] ?? status}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
