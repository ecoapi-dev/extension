import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import { Leaf, Server, Activity, DollarSign, AlertTriangle, TrendingDown, Loader2 } from 'lucide-react';
import { useProject, useCost, useCostByProvider, useSuggestions, useCreateScan } from '@/lib/queries';
import type { ApiCallInput } from '@/lib/types';

function useAnimatedValue(target: number, duration = 800) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    setDisplay(0);
    if (target === 0) return;
    const startTime = performance.now();
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      setDisplay(target * eased);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [target, duration]);

  return display;
}

function AnimatedStatValue({
  value,
  format,
}: {
  value: number | undefined;
  format: (n: number) => string;
}) {
  const display = useAnimatedValue(value ?? 0);

  if (value === undefined) return <span>-</span>;
  return <span>{format(display)}</span>;
}

function AnimatedBar({ percent, backgroundColor }: { percent: number; backgroundColor: string }) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    setWidth(0);
    const id = requestAnimationFrame(() => setWidth(percent));
    return () => cancelAnimationFrame(id);
  }, [percent]);

  return (
    <div
      className="h-full rounded-md transition-all duration-700 ease-out"
      style={{ width: `${width}%`, backgroundColor }}
    />
  );
}

function EcoGauge({ score }: { score: number }) {
  const [displayScore, setDisplayScore] = useState(0);
  const circumference = 2 * Math.PI * 58;
  const offset = circumference - (displayScore / 100) * circumference;
  const color = score >= 70 ? '#4EAA57' : score >= 40 ? '#B8A038' : '#C45A4A';

  useEffect(() => {
    setDisplayScore(0);
    if (score === 0) return;
    const duration = 1000;
    const startTime = performance.now();
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      setDisplayScore(score * eased);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [score]);

  return (
    <div className="relative flex items-center justify-center w-44 h-44">
      <svg className="w-44 h-44 -rotate-90" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="58" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
        <circle
          cx="64" cy="64" r="58"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[32px]" style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>{Math.round(displayScore)}</span>
        <span className="text-[11px] tracking-wider uppercase" style={{ color: 'rgba(255,255,255,0.45)' }}>Eco Score</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projectData, isLoading: loadingProject } = useProject(projectId);
  const { data: costData, isLoading: loadingCost } = useCost(projectId);
  const { data: providerData, isLoading: loadingProviders } = useCostByProvider(projectId);
  const { data: suggestionsData } = useSuggestions(projectId, { limit: 100 });

  const [showRescan, setShowRescan] = useState(false);

  const project = projectData?.data;
  const cost = costData?.data;
  const providers = providerData?.data ?? [];
  const suggestions = suggestionsData?.data ?? [];

  const isLoading = loadingProject || loadingCost;

  const summary = project?.summary;
  const highRisk = suggestions.filter((s) => s.severity === 'high').length;
  const totalSuggestions = suggestions.length;
  const ecoScore = summary
    ? Math.max(0, Math.min(100, Math.round(
        100 - (highRisk * 15) - (totalSuggestions * 3) + (summary.endpoints > 0 ? 10 : 0)
      )))
    : 0;

  const totalSavings = suggestions.reduce((sum, s) => sum + s.estimatedMonthlySavings, 0);
  const totalProviderCost = providers.reduce((sum, p) => sum + p.monthlyCost, 0);

  const stats = [
    { label: 'Endpoints', value: cost?.endpointCount, format: (n: number) => Math.round(n).toString(), icon: Server },
    { label: 'Daily API Calls', value: cost?.totalCallsPerDay, format: (n: number) => Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 }), icon: Activity },
    { label: 'Monthly Cost', value: cost?.totalMonthlyCost, format: (n: number) => `$${n.toFixed(2)}`, icon: DollarSign },
    { label: 'High Risk', value: highRisk, format: (n: number) => Math.round(n).toString(), icon: AlertTriangle },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-[#4EAA57]" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto scrollbar-hide">
    <div className="p-6 space-y-5 max-w-[960px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
            Dashboard
          </h1>
          <p className="text-[12px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
            API sustainability overview
            {summary ? ` · ${summary.scans} scan${summary.scans !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
        <button
          onClick={() => setShowRescan(true)}
          className="px-3 py-1.5 text-[11px] rounded-md transition-colors"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }}
        >
          Re-scan Project
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-5">
        <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-xl p-5 flex flex-col items-center justify-center">
          <EcoGauge score={ecoScore} />
          <p className="text-[11px] mt-2 text-center" style={{ color: 'rgba(255,255,255,0.45)' }}>
            {ecoScore >= 70 ? 'Good standing' : ecoScore >= 40 ? 'Needs improvement' : 'Critical'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.45)' }}>{stat.label}</span>
                <stat.icon size={14} className="text-[#4EAA57]/60" />
              </div>
              <div>
                <span className="text-[22px] text-white">
                  <AnimatedStatValue value={stat.value} format={stat.format} />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {totalSavings > 0 && (
        <div className="bg-[#4EAA57]/10 border border-[#4EAA57]/20 rounded-xl px-5 py-3.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#4EAA57]/15 flex items-center justify-center shrink-0">
            <Leaf size={16} className="text-[#4EAA57]" />
          </div>
          <div className="flex-1">
            <p className="text-[12px] text-white">
              Implementing all suggestions saves <span className="text-[#4EAA57]">${totalSavings.toFixed(2)}/mo</span>
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>
              Based on {totalSuggestions} optimization suggestion{totalSuggestions !== 1 ? 's' : ''} across {providers.length} provider{providers.length !== 1 ? 's' : ''}
            </p>
          </div>
          <TrendingDown size={16} className="text-[#4EAA57] shrink-0" />
        </div>
      )}

      {!loadingProviders && providers.length > 0 && (
        <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-xl p-5">
          <h3 className="text-[13px] text-white mb-4">Provider Cost Breakdown</h3>
          <div className="space-y-3">
            {providers.map((p, idx) => {
              const percent = totalProviderCost > 0 ? Math.round((p.monthlyCost / totalProviderCost) * 100) : 0;
              const colors = ['#4EAA57', '#5CBF65', '#3D8B44', '#2E6E34', '#1F4F24'];
              return (
                <div key={p.provider} className="flex items-center gap-3">
                  <span className="text-[11px] w-20 shrink-0 capitalize" style={{ color: 'rgba(255,255,255,0.45)' }}>{p.provider}</span>
                  <div className="flex-1 h-5 bg-black/50 rounded-md overflow-hidden relative">
                    <AnimatedBar percent={percent} backgroundColor={colors[idx % colors.length]} />
                  </div>
                  <span className="text-[11px] text-white w-16 text-right">${p.monthlyCost.toFixed(2)}</span>
                  <span className="text-[10px] w-8 text-right" style={{ color: 'rgba(255,255,255,0.4)' }}>{percent}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loadingProject && summary && summary.scans === 0 && (
        <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-xl p-8 text-center">
          <p className="text-[13px]" style={{ color: 'rgba(255,255,255,0.45)' }}>No scans yet. Run a scan to see analytics.</p>
          <button
            onClick={() => setShowRescan(true)}
            className="mt-3 px-4 py-2 text-[11px] bg-[#4EAA57]/10 border border-[#4EAA57]/20 rounded-md text-[#4EAA57] hover:bg-[#4EAA57]/20 transition-colors"
          >
            Run First Scan
          </button>
        </div>
      )}

      {showRescan && projectId && (
        <RescanDialog projectId={projectId} onClose={() => setShowRescan(false)} />
      )}
    </div>
    </div>
  );
}

function RescanDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [json, setJson] = useState('');
  const createScan = useCreateScan(projectId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const apiCalls: ApiCallInput[] = JSON.parse(json);
      await createScan.mutateAsync({ apiCalls });
      onClose();
    } catch {
      // invalid JSON
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-black/75 backdrop-blur-xl border border-white/[0.08] rounded-xl p-6">
        <h2 className="text-[16px] text-white mb-4" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 600 }}>New Scan</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] mb-1.5 uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.45)' }}>API Calls JSON</label>
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='[{"file":"src/api.ts","line":10,"method":"GET","url":"https://api.stripe.com/v1/charges","library":"fetch"}]'
              rows={8}
              required
              className="w-full bg-black/40 border border-white/[0.1] rounded-lg px-3 py-2 text-[11px] text-white placeholder:text-white/20 focus:outline-none focus:border-[#4EAA57]/40 font-mono resize-none"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[12px] transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!json.trim() || createScan.isPending}
              className="flex-1 py-2 rounded-lg text-[12px] text-white bg-[#4EAA57] hover:bg-[#3D8B44] transition-colors disabled:opacity-40"
            >
              {createScan.isPending ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Run Scan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
