import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router';
import {
  Loader2,
  Calculator,
  ChevronDown,
  ChevronRight,
  Save,
  Trash2,
  BarChart2,
  Download,
  X,
} from 'lucide-react';
import { useEndpoints, useRunSimulation, useScenarios, useSaveScenario, useDeleteScenario } from '@/lib/queries';
import type {
  InputMode,
  SimulatorInput,
  SimulatorResult,
  ProviderSimResult,
  EndpointSimResult,
  SavedScenario,
  EndpointRecord,
} from '@/lib/types';
import { SCALE_PRESETS } from '@/lib/types';
import { ScenarioCompare } from '@/components/ScenarioCompare';

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
function fmtRange(low: number, high: number): string {
  return `${fmt(low)} – ${fmt(high)}`;
}
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: '#22c55e', POST: '#3b82f6', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444',
};

function MethodBadge({ method }: { method: string }) {
  const color = METHOD_COLORS[method.toUpperCase()] ?? '#6b7280';
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0 rounded border shrink-0"
      style={{ color, borderColor: color, lineHeight: '18px' }}
    >
      {method.toUpperCase()}
    </span>
  );
}

function CostBar({ pct }: { pct: number }) {
  return (
    <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden mt-1">
      <div
        className="h-full rounded-full bg-[#4EAA57] transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderSimResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-white/[0.06] last:border-0">
      <button
        className="w-full flex items-start gap-2 py-3 px-4 hover:bg-white/[0.02] transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown size={14} className="mt-0.5 text-white/40 shrink-0" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 text-white/40 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-baseline gap-3">
            <span className="text-[13px] font-semibold text-white truncate">
              {provider.provider}
            </span>
            <span className="text-[13px] text-white font-medium shrink-0">
              {fmtRange(provider.monthlyCost.low, provider.monthlyCost.high)}/mo
            </span>
          </div>
          <div className="flex justify-between text-[11px] text-white/40 mt-0.5">
            <span>{fmtRange(provider.dailyCost.low, provider.dailyCost.high)}/day</span>
            <span>{provider.percentOfTotal.toFixed(1)}% of total</span>
          </div>
          <CostBar pct={provider.percentOfTotal} />
        </div>
      </button>

      {expanded && (
        <div className="pl-6 pb-2">
          {provider.endpoints.map((ep) => (
            <EndpointRow key={ep.endpointId} endpoint={ep} />
          ))}
        </div>
      )}
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: EndpointSimResult }) {
  return (
    <div className="py-2 px-4 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-2 mb-1">
        <MethodBadge method={endpoint.method} />
        <span className="text-[12px] text-white/80 truncate flex-1 min-w-0" title={endpoint.url}>
          {endpoint.url}
        </span>
        <span className="text-[12px] text-white font-medium shrink-0">
          {fmtRange(endpoint.monthlyCost.low, endpoint.monthlyCost.high)}/mo
        </span>
      </div>
      <div className="flex justify-between text-[11px] text-white/40">
        <span>{fmtNum(endpoint.scaledCallsPerDay)} calls/day</span>
        <span>{fmtRange(endpoint.dailyCost.low, endpoint.dailyCost.high)}/day</span>
      </div>
      <CostBar pct={endpoint.percentOfTotal} />
    </div>
  );
}

// ─── Save Scenario Modal ──────────────────────────────────────────────────────

function SaveScenarioModal({
  onSave,
  onClose,
}: {
  onSave: (label: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0f0f0f] border border-white/[0.12] rounded-2xl p-6 w-[360px] shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-[15px] font-semibold text-white">Save Scenario</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>
        <input
          autoFocus
          type="text"
          placeholder='e.g. "Launch — 5K users"'
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) onSave(label.trim()); }}
          className="w-full bg-black/40 border border-white/[0.12] rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-white/30 outline-none focus:border-[#4EAA57]/60 mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[12px] text-white/60 hover:text-white transition-colors rounded-lg border border-white/[0.08]"
          >
            Cancel
          </button>
          <button
            disabled={!label.trim()}
            onClick={() => label.trim() && onSave(label.trim())}
            className="px-4 py-2 text-[12px] bg-[#4EAA57] text-black font-semibold rounded-lg disabled:opacity-40 hover:bg-[#5aba63] transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Simulator() {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: endpointsData, isLoading: endpointsLoading } = useEndpoints(projectId, { limit: 500 });
  const { data: scenariosData, isLoading: scenariosLoading } = useScenarios(projectId);
  const runMutation = useRunSimulation(projectId);
  const saveMutation = useSaveScenario(projectId);
  const deleteMutation = useDeleteScenario(projectId);

  const endpoints: EndpointRecord[] = endpointsData?.data ?? [];
  const scenarios: SavedScenario[] = scenariosData?.data ?? [];

  const [mode, setMode] = useState<InputMode>('user-centric');
  const [dau, setDau] = useState('');
  const [callsPerUser, setCallsPerUser] = useState('1');
  const [totalCalls, setTotalCalls] = useState('');
  const [grouping, setGrouping] = useState<'provider' | 'endpoint'>('provider');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [exportWarning, setExportWarning] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildInput = useCallback((): SimulatorInput => {
    const frequencyOverrides: Record<string, number> = {};
    for (const [id, val] of Object.entries(overrides)) {
      const n = parseFloat(val);
      if (!isNaN(n) && n >= 0) frequencyOverrides[id] = n;
    }
    if (mode === 'user-centric') {
      return { mode, dau: dau ? parseFloat(dau) : undefined, callsPerUserPerDay: callsPerUser ? parseFloat(callsPerUser) : 1, frequencyOverrides };
    }
    return { mode, totalCallsPerDay: totalCalls ? parseFloat(totalCalls) : undefined, frequencyOverrides };
  }, [mode, dau, callsPerUser, totalCalls, overrides]);

  // Auto-run simulation on input change (debounced)
  useEffect(() => {
    if (endpoints.length === 0) return;
    const input = buildInput();
    const hasValue = input.mode === 'user-centric' ? (input.dau ?? 0) > 0 : (input.totalCallsPerDay ?? 0) > 0;
    if (!hasValue) { setResult(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runMutation.mutate(input, {
        onSuccess: (data) => setResult(data.data),
        onError: () => setResult(null),
      });
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dau, callsPerUser, totalCalls, overrides, endpoints.length]);

  function switchMode(newMode: InputMode) {
    if (newMode === mode) return;
    if (newMode === 'volume-centric') {
      const d = parseFloat(dau); const c = parseFloat(callsPerUser) || 1;
      if (!isNaN(d) && d > 0) setTotalCalls(String(Math.round(d * c)));
    } else {
      const t = parseFloat(totalCalls); const d = parseFloat(dau);
      if (!isNaN(t) && !isNaN(d) && d > 0) setCallsPerUser(String(Math.max(1, Math.round(t / d))));
    }
    setMode(newMode);
  }

  function applyPreset(preset: (typeof SCALE_PRESETS)[number]) {
    if (mode === 'user-centric') setDau(String(preset.dau));
    else setTotalCalls(String(preset.volume));
  }

  function toggleCompare(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  useEffect(() => {
    if (compareIds.length > 0) setExportWarning(false);
  }, [compareIds]);

  function handleExport() {
    if (compareIds.length === 0) {
      setExportWarning(true);
      return;
    }
    setExportWarning(false);
    const url = `/api/projects/${projectId}/simulator/scenarios/export?ids=${compareIds.join(',')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eco-scenarios.csv';
    a.click();
  }

  async function handleSave(label: string) {
    if (!result) return;
    const input = buildInput();
    await saveMutation.mutateAsync({ label, input, result });
    setShowSaveModal(false);
  }

  const flatEndpoints: EndpointSimResult[] = result
    ? result.byProvider.flatMap((p) => p.endpoints).sort((a, b) => b.monthlyCost.mid - a.monthlyCost.mid)
    : [];

  const compareScenarios = compareIds
    .map((id) => scenarios.find((s) => s.id === id))
    .filter(Boolean) as SavedScenario[];

  const inputClass = "w-full bg-black/40 border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-white/30 outline-none focus:border-[#4EAA57]/60 transition-colors";

  if (endpointsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="animate-spin text-[#4EAA57]" />
      </div>
    );
  }

  if (endpoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <Calculator size={40} className="mx-auto text-white/20" />
          <p className="text-[14px] text-white/40">No scan data available.</p>
          <p className="text-[12px] text-white/30">Run a scan from the VS Code extension first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto scrollbar-hide">
      <div className="pt-14 px-8 pb-8 max-w-[1240px] mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-[26px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
            Cost Simulator
          </h1>
          <p className="text-[14px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
            Project API costs at scale · {endpoints.length} endpoints from latest scan
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">

          {/* ── Input Panel ─────────────────────────────────────────────────── */}
          <div className="space-y-5">
            <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-5 space-y-4">

              {/* Mode toggle */}
              <div className="flex gap-1 bg-black/40 rounded-lg p-0.5">
                {(['user-centric', 'volume-centric'] as InputMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => switchMode(m)}
                    className={`flex-1 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                      mode === m
                        ? 'bg-[#4EAA57] text-black shadow'
                        : 'text-white/50 hover:text-white/80'
                    }`}
                  >
                    {m === 'user-centric' ? 'Per User' : 'Total Volume'}
                  </button>
                ))}
              </div>

              {/* Inputs */}
              {mode === 'user-centric' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-white/40 mb-1.5">Daily Active Users</label>
                    <input type="number" min="0" placeholder="e.g. 1000" value={dau}
                      onChange={(e) => setDau(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/40 mb-1.5">Calls / user / day</label>
                    <input type="number" min="0" step="0.1" placeholder="1" value={callsPerUser}
                      onChange={(e) => setCallsPerUser(e.target.value)} className={inputClass} />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] text-white/40 mb-1.5">Total API Calls / Day</label>
                  <input type="number" min="0" placeholder="e.g. 5000" value={totalCalls}
                    onChange={(e) => setTotalCalls(e.target.value)} className={inputClass} />
                </div>
              )}

              {/* Scale presets */}
              <div>
                <p className="text-[11px] text-white/40 mb-2">Quick scale</p>
                <div className="flex gap-2 flex-wrap">
                  {SCALE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => applyPreset(p)}
                      className="px-3 py-1 text-[11px] rounded-full border border-white/[0.12] text-white/60 hover:text-white hover:border-white/30 transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Frequency overrides */}
              <div>
                <button
                  onClick={() => setShowOverrides((v) => !v)}
                  className="flex items-center gap-1.5 text-[11px] text-[#4EAA57] hover:text-[#5aba63] transition-colors"
                >
                  {showOverrides ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Frequency overrides ({endpoints.length} endpoints)
                </button>
                {showOverrides && (
                  <div className="mt-2 border border-white/[0.08] rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                    {endpoints.map((ep) => (
                      <div
                        key={ep.id}
                        className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.05] last:border-0"
                      >
                        <MethodBadge method={ep.method} />
                        <span className="flex-1 text-[11px] text-white/60 truncate" title={ep.url}>{ep.url}</span>
                        <input
                          type="number" min="0" step="0.1" placeholder="1"
                          value={overrides[ep.id] ?? ''}
                          onChange={(e) => setOverrides((prev) => ({ ...prev, [ep.id]: e.target.value }))}
                          className="w-14 bg-black/40 border border-white/[0.1] rounded px-2 py-0.5 text-[11px] text-white outline-none focus:border-[#4EAA57]/60"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Save + actions */}
            {result && (
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSaveModal(true)}
                  disabled={saveMutation.isPending}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-[#4EAA57]/10 border border-[#4EAA57]/30 text-[#4EAA57] text-[12px] font-medium hover:bg-[#4EAA57]/20 transition-colors disabled:opacity-40"
                >
                  <Save size={13} />
                  {saveMutation.isPending ? 'Saving…' : 'Save Scenario'}
                </button>
                {compareIds.length === 2 && (
                  <button
                    onClick={() => setShowCompare(true)}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.06] border border-white/[0.1] text-white/70 text-[12px] hover:text-white transition-colors"
                  >
                    <BarChart2 size={13} />
                    Compare
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── Results Panel ────────────────────────────────────────────────── */}
          <div className="space-y-4">
            {runMutation.isPending && !result && (
              <div className="flex items-center justify-center h-32">
                <Loader2 size={24} className="animate-spin text-[#4EAA57]" />
              </div>
            )}

            {result && (
              <>
                {/* Total cost banner */}
                <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-5">
                  <p className="text-[11px] text-white/40 mb-1">Estimated Monthly Cost</p>
                  <p className="text-[28px] font-bold text-white mb-1">
                    {fmtRange(result.totalMonthlyCost.low, result.totalMonthlyCost.high)}
                  </p>
                  <p className="text-[12px] text-white/40 mb-3">
                    Daily: {fmtRange(result.totalDailyCost.low, result.totalDailyCost.high)}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">
                      LOW CONFIDENCE
                    </span>
                    <span className="text-[11px] text-white/30">Static analysis · ±30% range</span>
                  </div>
                </div>

                {/* Grouping + results */}
                <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
                  <div className="flex gap-0 border-b border-white/[0.06]">
                    {(['provider', 'endpoint'] as const).map((g) => (
                      <button
                        key={g}
                        onClick={() => setGrouping(g)}
                        className={`flex-1 py-2.5 text-[12px] font-medium transition-colors ${
                          grouping === g ? 'text-[#4EAA57] border-b-2 border-[#4EAA57]' : 'text-white/40 hover:text-white/70'
                        }`}
                      >
                        By {g === 'provider' ? 'Provider' : 'Endpoint'}
                      </button>
                    ))}
                  </div>
                  <div>
                    {grouping === 'provider'
                      ? result.byProvider.map((p) => <ProviderRow key={p.provider} provider={p} />)
                      : flatEndpoints.map((ep) => <EndpointRow key={ep.endpointId} endpoint={ep} />)}
                  </div>
                </div>

                <p className="text-[11px] text-white/25 px-1">
                  Estimates use average per-request costs from the provider registry.
                </p>
              </>
            )}

            {!result && !runMutation.isPending && (
              <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-10 text-center">
                <Calculator size={32} className="mx-auto mb-3 text-white/20" />
                <p className="text-[13px] text-white/40">Enter a user count or call volume to see projections.</p>
              </div>
            )}
          </div>
        </div>

        {/* ── Saved Scenarios ─────────────────────────────────────────────────── */}
        {(scenarios.length > 0 || scenariosLoading) && (
          <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
              <div>
                <h2 className="text-[14px] font-semibold text-white">Saved Scenarios</h2>
                <p className="text-[11px] text-white/40 mt-0.5">Select up to 2 to compare</p>
              </div>
              {scenarios.length > 0 && (
                <div className="flex flex-col items-end gap-1">
                  <button
                    onClick={handleExport}
                    className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white transition-colors px-3 py-1.5 rounded-lg border border-white/[0.08] hover:border-white/20"
                  >
                    <Download size={12} />
                    Export CSV
                  </button>
                  {exportWarning && (
                    <p className="text-[11px] text-[#C45A4A]">Select at least one scenario to export.</p>
                  )}
                </div>
              )}
            </div>

            {scenariosLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={20} className="animate-spin text-[#4EAA57]" />
              </div>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {scenarios.map((scenario) => {
                  const selected = compareIds.includes(scenario.id);
                  return (
                    <div
                      key={scenario.id}
                      className={`flex items-center gap-4 px-5 py-3.5 hover:bg-white/[0.02] transition-colors ${selected ? 'bg-[#4EAA57]/5' : ''}`}
                    >
                      <button
                        onClick={() => toggleCompare(scenario.id)}
                        className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                          selected
                            ? 'bg-[#4EAA57] border-[#4EAA57]'
                            : 'border-white/[0.15] hover:border-[#4EAA57]/50'
                        }`}
                      >
                        {selected && <span className="text-black text-[10px] font-bold">✓</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-white truncate">{scenario.label}</p>
                        <p className="text-[11px] text-white/35 mt-0.5">
                          {fmtDate(scenario.createdAt)} ·{' '}
                          {fmtRange(scenario.result.totalMonthlyCost.low, scenario.result.totalMonthlyCost.high)}/mo ·{' '}
                          {scenario.input.mode === 'user-centric'
                            ? `${fmtNum(scenario.input.dau ?? 0)} DAU`
                            : `${fmtNum(scenario.input.totalCallsPerDay ?? 0)} calls/day`}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteMutation.mutate(scenario.id)}
                        className="text-white/20 hover:text-[#C45A4A] transition-colors p-1"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {compareIds.length === 2 && (
              <div className="px-5 py-3 border-t border-white/[0.06] flex justify-end">
                <button
                  onClick={() => setShowCompare(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#4EAA57]/10 border border-[#4EAA57]/30 text-[#4EAA57] text-[12px] font-medium hover:bg-[#4EAA57]/20 transition-colors"
                >
                  <BarChart2 size={13} />
                  Compare Selected
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showSaveModal && result && (
        <SaveScenarioModal onSave={handleSave} onClose={() => setShowSaveModal(false)} />
      )}
      {showCompare && compareScenarios.length === 2 && (
        <ScenarioCompare
          scenarios={compareScenarios as [SavedScenario, SavedScenario]}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
