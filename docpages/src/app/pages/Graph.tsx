import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import { X, Loader2, ChevronDown } from 'lucide-react';
import { useGraph } from '@/lib/queries';
import type { EndpointStatus } from '@/lib/types';

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

  const positioned = useMemo(() => {
    const fileIds = [...new Set(edges.map((e) => e.source))];
    const result: PositionedNode[] = [];

    // Tree geometry in canvas coordinates (tuned for ~1440px viewport)
    const CX = 640;        // horizontal center of tree
    const CY = 275;        // vertical center of foliage
    const RX = 130;        // horizontal radius of foliage ellipse
    const RY = 145;        // vertical radius of foliage ellipse
    const MIN_D = 62;      // minimum center-to-center distance between API nodes (44px + 18px gap)

    // --- 1. Place API nodes using a golden-angle spiral (non-overlapping, no gap) ---
    // Golden-angle spiral distributes points evenly — deterministic so layout is stable
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const candidates: { x: number; y: number }[] = [];
    const totalCandidates = Math.max(nodes.length * 6, 50);
    for (let i = 0; i < totalCandidates; i++) {
      const r = Math.sqrt((i + 0.5) / totalCandidates);
      const theta = i * goldenAngle;
      candidates.push({
        x: Math.round(CX + r * RX * Math.cos(theta)),
        y: Math.round(CY + r * RY * Math.sin(theta)),
      });
    }

    // Greedily pick non-overlapping positions
    const picked: { x: number; y: number }[] = [];
    for (const c of candidates) {
      if (picked.length >= nodes.length) break;
      if (picked.every(p => Math.hypot(p.x - c.x, p.y - c.y) >= MIN_D)) {
        picked.push(c);
      }
    }
    // Fallback if spiral didn't yield enough (shouldn't happen with 6× candidates)
    while (picked.length < nodes.length) {
      picked.push({ x: CX + (picked.length % 3 - 1) * MIN_D, y: CY + Math.floor(picked.length / 3) * MIN_D });
    }

    const apiXY: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, i) => {
      const { x, y } = picked[i];
      apiXY[n.id] = { x, y };
      const method = n.label.split(' ')[0] ?? '';
      const url = n.label.split(' ').slice(1).join(' ') || n.label;
      result.push({ id: n.id, type: 'api', label: url, status: n.status, provider: n.provider, monthlyCost: n.monthlyCost, method, x, y });
    });

    // --- 2. Place file boxes on the side nearest their connected API nodes ---
    const fileInfo = fileIds.map((fid) => {
      const pts = edges
        .filter((e) => e.source === fid)
        .map((e) => apiXY[e.target])
        .filter(Boolean) as { x: number; y: number }[];
      const cx = pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : CX;
      const cy = pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : 280;
      return { id: fid, cx, cy };
    });

    type Side = 'left' | 'right' | 'btm-left' | 'btm-right';
    const sides: Record<Side, typeof fileInfo> = { left: [], right: [], 'btm-left': [], 'btm-right': [] };
    for (const f of fileInfo) {
      const side: Side = f.cy > 300
        ? (f.cx <= CX ? 'btm-left' : 'btm-right')
        : (f.cx <= CX ? 'left' : 'right');
      sides[side].push(f);
    }

    // Left files: x=95, y tracks centroid
    sides.left.sort((a, b) => a.cy - b.cy);
    let prevY = -Infinity;
    for (const f of sides.left) {
      const y = Math.max(f.cy - 16, prevY + 55, 80);
      prevY = y;
      result.push({ id: f.id, type: 'file', label: f.id.split('/').pop() ?? f.id, x: 95, y });
    }

    // Right files: x = CX+295
    sides.right.sort((a, b) => a.cy - b.cy);
    prevY = -Infinity;
    for (const f of sides.right) {
      const y = Math.max(f.cy - 16, prevY + 55, 80);
      prevY = y;
      result.push({ id: f.id, type: 'file', label: f.id.split('/').pop() ?? f.id, x: CX + 295, y });
    }

    // Bottom-left files: stack leftward from CX
    const BTM_Y = 510;
    sides['btm-left'].sort((a, b) => b.cx - a.cx);
    let prevX = CX - 20;
    for (const f of sides['btm-left']) {
      const x = Math.min(prevX - 10, Math.max(100, f.cx - 70));
      prevX = x - 140;
      result.push({ id: f.id, type: 'file', label: f.id.split('/').pop() ?? f.id, x, y: BTM_Y });
    }

    // Bottom-right files: stack rightward from CX
    sides['btm-right'].sort((a, b) => a.cx - b.cx);
    prevX = CX + 20;
    for (const f of sides['btm-right']) {
      const x = Math.max(prevX + 10, Math.min(800, f.cx + 20));
      prevX = x + 140;
      result.push({ id: f.id, type: 'file', label: f.id.split('/').pop() ?? f.id, x, y: BTM_Y });
    }

    return result;
  }, [nodes, edges]);

  // Per-node positions (updated when nodes drag)
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});

  // Reset positions whenever the underlying data changes
  useEffect(() => {
    const initial: Record<string, { x: number; y: number }> = {};
    positioned.forEach((n) => { initial[n.id] = { x: n.x, y: n.y }; });
    setNodePositions(initial);
  }, [positioned]);

  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [pan, setPan] = useState({ x: 40, y: 0 });
  const panRef = useRef({ x: 40, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Node drag state
  const draggingNodeId = useRef<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [draggingId, setDraggingId] = useState<string | null>(null); // for cursor

  // Container ref to convert mouse coords → canvas coords
  const outerRef = useRef<HTMLDivElement>(null);

  // Keep panRef in sync so drag handlers always have the latest pan
  useEffect(() => { panRef.current = pan; }, [pan]);

  // --- Node drag handlers ---
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    e.preventDefault();
    draggingNodeId.current = nodeId;
    setDraggingId(nodeId);
    const rect = outerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const pos = nodePositions[nodeId] ?? { x: 0, y: 0 };
    const canvasX = e.clientX - rect.left - panRef.current.x;
    const canvasY = e.clientY - rect.top - panRef.current.y;
    dragOffset.current = { x: canvasX - pos.x, y: canvasY - pos.y };
  }, [nodePositions]);

  // --- Canvas pan handlers ---
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.graph-node')) return;
    setIsPanning(true);
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (draggingNodeId.current) {
      const rect = outerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const canvasX = e.clientX - rect.left - panRef.current.x;
      const canvasY = e.clientY - rect.top - panRef.current.y;
      const id = draggingNodeId.current;
      setNodePositions((prev) => ({
        ...prev,
        [id]: {
          x: canvasX - dragOffset.current.x,
          y: canvasY - dragOffset.current.y,
        },
      }));
      return;
    }
    if (!isPanning) return;
    const newPan = {
      x: pan.x + (e.clientX - lastPos.current.x),
      y: pan.y + (e.clientY - lastPos.current.y),
    };
    panRef.current = newPan;
    setPan(newPan);
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, [isPanning, pan]);

  const handleMouseUp = useCallback(() => {
    draggingNodeId.current = null;
    setDraggingId(null);
    setIsPanning(false);
  }, []);

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseUp]);

  // Compute edge center using live nodePositions
  const getNodeCenter = (nodeId: string, type: 'file' | 'api') => {
    const pos = nodePositions[nodeId];
    if (!pos) return { x: 0, y: 0 };
    if (type === 'file') return { x: pos.x + 65, y: pos.y + 16 };
    return { x: pos.x + 22, y: pos.y + 22 };
  };

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
          <h1 className="text-[20px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
            Dependency Graph
          </h1>
          <p className="text-[12px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
            File &rarr; API endpoint relationships · {nodes.length} endpoints · Drag nodes · Click for details
          </p>
        </div>
        <div className="relative">
          <select
            value={clusterBy}
            onChange={(e) => setClusterBy(e.target.value)}
            className="appearance-none bg-black/40 backdrop-blur-sm border border-white/[0.1] rounded-lg px-3 py-1.5 pr-8 text-[11px] text-white focus:outline-none focus:border-[#4EAA57]/40 cursor-pointer"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="provider">Group by Provider</option>
            <option value="file">Group by File</option>
            <option value="cost">Group by Cost</option>
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'rgba(255,255,255,0.35)' }} />
        </div>
      </div>

      {nodes.length === 0 && (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'rgba(255,255,255,0.35)' }}>
          <p className="text-[12px]">No graph data. Run a scan first.</p>
        </div>
      )}

      {nodes.length > 0 && (
        <div
          ref={outerRef}
          className="flex-1 relative overflow-hidden"
          style={{
            background: 'radial-gradient(circle at 50% 30%, rgba(78,170,87,0.05) 0%, transparent 70%)',
            cursor: draggingId ? 'grabbing' : isPanning ? 'grabbing' : 'grab',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {/* Grid pattern */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-[0.04]">
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#4EAA57" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>

          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            {/* Edges — overflow:visible so lines aren't clipped when nodes are dragged far */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ overflow: 'visible' }}
            >
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#4EAA57" opacity="0.4" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const fromNode = positioned.find((n) => n.id === edge.source);
                const toNode = positioned.find((n) => n.id === edge.target);
                if (!fromNode || !toNode) return null;
                const from = getNodeCenter(edge.source, fromNode.type);
                const to = getNodeCenter(edge.target, toNode.type);
                const isHighlighted = selected && (selected.id === edge.source || selected.id === edge.target);
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${edge.line}`}
                    x1={from.x} y1={from.y}
                    x2={to.x} y2={to.y}
                    stroke={isHighlighted ? '#4EAA57' : 'rgba(255,255,255,0.1)'}
                    strokeWidth={isHighlighted ? 1.5 : 1}
                    opacity={isHighlighted ? 0.8 : 0.5}
                    markerEnd="url(#arrowhead)"
                  />
                );
              })}
            </svg>

            {/* Nodes */}
            {positioned.map((node) => {
              const pos = nodePositions[node.id] ?? { x: node.x, y: node.y };
              const isSelected = selected?.id === node.id;
              const isConnected = selected && edges.some(
                (e) => (e.source === selected.id && e.target === node.id) || (e.target === selected.id && e.source === node.id)
              );
              const dimmed = selected && !isSelected && !isConnected;
              const isBeingDragged = draggingId === node.id;

              if (node.type === 'file') {
                return (
                  <div
                    key={node.id}
                    className="graph-node absolute"
                    style={{
                      left: pos.x,
                      top: pos.y,
                      opacity: dimmed ? 0.3 : 1,
                      cursor: isBeingDragged ? 'grabbing' : 'grab',
                      zIndex: isBeingDragged ? 10 : 1,
                      userSelect: 'none',
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                    onClick={() => setSelected(isSelected ? null : node)}
                  >
                    <div
                      className="px-3 py-1.5 rounded-md border text-[11px] backdrop-blur-sm transition-colors"
                      style={{
                        backgroundColor: isSelected ? 'rgba(78,170,87,0.15)' : 'rgba(0,0,0,0.4)',
                        borderColor: isBeingDragged
                          ? 'rgba(78,170,87,0.6)'
                          : isSelected
                          ? 'rgba(78,170,87,0.4)'
                          : 'rgba(255,255,255,0.1)',
                        color: isSelected ? '#fff' : 'rgba(255,255,255,0.5)',
                        boxShadow: isBeingDragged ? '0 4px 20px rgba(78,170,87,0.2)' : 'none',
                      }}
                    >
                      {node.label}
                    </div>
                  </div>
                );
              }

              const color = statusColors[node.status ?? 'normal'] || '#4EAA57';
              return (
                <div
                  key={node.id}
                  className="graph-node absolute"
                  style={{
                    left: pos.x,
                    top: pos.y,
                    opacity: dimmed ? 0.3 : 1,
                    cursor: isBeingDragged ? 'grabbing' : 'grab',
                    zIndex: isBeingDragged ? 10 : 1,
                    userSelect: 'none',
                  }}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  onClick={() => setSelected(isSelected ? null : node)}
                >
                  <div
                    className="w-11 h-11 rounded-full border-2 flex items-center justify-center text-[9px] transition-colors"
                    style={{
                      borderColor: isBeingDragged ? color : isSelected ? color : `${color}60`,
                      backgroundColor: `${color}15`,
                      boxShadow: isBeingDragged
                        ? `0 4px 20px ${color}40`
                        : isSelected
                        ? `0 0 12px ${color}30`
                        : 'none',
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
            <div className="absolute top-4 right-4 w-64 bg-black/60 backdrop-blur-xl border border-white/[0.1] rounded-xl p-4 shadow-xl z-20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.45)' }}>
                  {selected.type === 'file' ? 'File' : 'API Endpoint'}
                </span>
                <button onClick={() => setSelected(null)} style={{ color: 'rgba(255,255,255,0.45)' }} className="hover:text-white transition-colors">
                  <X size={14} />
                </button>
              </div>
              {selected.type === 'file' ? (
                <>
                  <p className="text-[13px] text-white mb-2">{selected.label}</p>
                  <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    {edges.filter((e) => e.source === selected.id).length} outgoing API calls
                  </p>
                </>
              ) : (
                <>
                  <code className="text-[12px] text-white block mb-2">{selected.label}</code>
                  <div className="space-y-1.5 text-[10px]">
                    <div className="flex justify-between">
                      <span style={{ color: 'rgba(255,255,255,0.45)' }}>Method</span>
                      <span className="text-white">{selected.method}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: 'rgba(255,255,255,0.45)' }}>Provider</span>
                      <span className="text-white capitalize">{selected.provider}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: 'rgba(255,255,255,0.45)' }}>Status</span>
                      <span style={{ color: statusColors[selected.status ?? 'normal'] }}>
                        {statusLabels[selected.status ?? 'normal'] ?? selected.status}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: 'rgba(255,255,255,0.45)' }}>Monthly Cost</span>
                      <span className="text-white">${selected.monthlyCost?.toFixed(2)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-black/60 backdrop-blur-sm border border-white/[0.08] rounded-lg px-3 py-2">
            <div className="flex items-center gap-4 text-[9px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-2 rounded-sm bg-black/40 border border-white/[0.15]" /> File
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
