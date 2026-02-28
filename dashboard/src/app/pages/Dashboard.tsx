import { useState } from 'react';
import { useParams } from 'react-router';
import { Leaf, Server, Activity, DollarSign, AlertTriangle, TrendingDown, Sprout, Loader2 } from 'lucide-react';
import { useProject, useCost, useCostByProvider, useSuggestions, useCreateScan } from '@/lib/queries';
import type { ApiCallInput } from '@/lib/types';

function EcoGauge({ score }: { score: number }) {
  const circumference = 2 * Math.PI * 58;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 70 ? '#4EAA57' : score >= 40 ? '#B8A038' : '#C45A4A';

  return (
    <div className="relative flex items-center justify-center w-44 h-44">
      <svg className="w-44 h-44 -rotate-90" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="58" fill="none" stroke="#1C271C" strokeWidth="8" />
        <circle
          cx="64" cy="64" r="58"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000 ease-out"
          style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[32px]" style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>{score}</span>
        <span className="text-[11px] text-[#7EA87E] tracking-wider uppercase">Eco Score</span>
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
    { label: 'Endpoints', value: cost?.endpointCount ?? '-', icon: Server },
    { label: 'Daily API Calls', value: cost ? cost.totalCallsPerDay.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-', icon: Activity },
    { label: 'Monthly Cost', value: cost ? `$${cost.totalMonthlyCost.toFixed(2)}` : '-', icon: DollarSign },
    { label: 'High Risk', value: highRisk, icon: AlertTriangle },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-[#4EAA57]" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-[960px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px] text-[#D6EDD0] flex items-center gap-2">
            <Sprout size={18} className="text-[#4EAA57]" />
            Dashboard
          </h1>
          <p className="text-[12px] text-[#7EA87E] mt-1">
            API sustainability overview
            {summary ? ` · ${summary.scans} scan${summary.scans !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
        <button
          onClick={() => setShowRescan(true)}
          className="px-3 py-1.5 text-[11px] bg-[#1C271C] border border-[#243224] rounded-md text-[#7EA87E] hover:text-[#D6EDD0] hover:border-[#4EAA57]/30 transition-colors"
        >
          Re-scan Project
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-5">
        <div className="bg-[#131A13] border border-[#243224] rounded-xl p-5 flex flex-col items-center justify-center">
          <EcoGauge score={ecoScore} />
          <p className="text-[11px] text-[#7EA87E] mt-2 text-center">
            {ecoScore >= 70 ? 'Good standing' : ecoScore >= 40 ? 'Needs improvement' : 'Critical'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-[#131A13] border border-[#243224] rounded-xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] text-[#7EA87E] uppercase tracking-wider">{stat.label}</span>
                <stat.icon size={14} className="text-[#4EAA57]/60" />
              </div>
              <div>
                <span className="text-[22px] text-[#D6EDD0]">{stat.value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {totalSavings > 0 && (
        <div className="bg-[#1C271C] border border-[#4EAA57]/20 rounded-xl px-5 py-3.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#4EAA57]/15 flex items-center justify-center shrink-0">
            <Leaf size={16} className="text-[#4EAA57]" />
          </div>
          <div className="flex-1">
            <p className="text-[12px] text-[#D6EDD0]">
              Implementing all suggestions saves <span className="text-[#4EAA57]">${totalSavings.toFixed(2)}/mo</span>
            </p>
            <p className="text-[10px] text-[#7EA87E] mt-0.5">
              Based on {totalSuggestions} optimization suggestion{totalSuggestions !== 1 ? 's' : ''} across {providers.length} provider{providers.length !== 1 ? 's' : ''}
            </p>
          </div>
          <TrendingDown size={16} className="text-[#4EAA57] shrink-0" />
        </div>
      )}

      {!loadingProviders && providers.length > 0 && (
        <div className="bg-[#131A13] border border-[#243224] rounded-xl p-5">
          <h3 className="text-[13px] text-[#D6EDD0] mb-4">Provider Cost Breakdown</h3>
          <div className="space-y-3">
            {providers.map((p, idx) => {
              const percent = totalProviderCost > 0 ? Math.round((p.monthlyCost / totalProviderCost) * 100) : 0;
              const colors = ['#4EAA57', '#5CBF65', '#3D8B44', '#2E6E34', '#1F4F24'];
              return (
                <div key={p.provider} className="flex items-center gap-3">
                  <span className="text-[11px] text-[#7EA87E] w-20 shrink-0 capitalize">{p.provider}</span>
                  <div className="flex-1 h-5 bg-[#0B0F0B] rounded-md overflow-hidden relative">
                    <div
                      className="h-full rounded-md transition-all duration-700 ease-out"
                      style={{ width: `${percent}%`, backgroundColor: colors[idx % colors.length] }}
                    />
                  </div>
                  <span className="text-[11px] text-[#D6EDD0] w-16 text-right">${p.monthlyCost.toFixed(2)}</span>
                  <span className="text-[10px] text-[#7EA87E] w-8 text-right">{percent}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loadingProject && summary && summary.scans === 0 && (
        <div className="bg-[#131A13] border border-[#243224] rounded-xl p-8 text-center">
          <p className="text-[13px] text-[#7EA87E]">No scans yet. Run a scan to see analytics.</p>
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
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0B0F0B] border border-[#243224] rounded-xl p-6">
        <h2 className="text-[16px] text-[#D6EDD0] mb-4">New Scan</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-[#7EA87E] mb-1.5 uppercase tracking-wider">API Calls JSON</label>
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='[{"file":"src/api.ts","line":10,"method":"GET","url":"https://api.stripe.com/v1/charges","library":"fetch"}]'
              rows={8}
              required
              className="w-full bg-[#131A13] border border-[#243224] rounded-lg px-3 py-2 text-[11px] text-[#D6EDD0] placeholder:text-[#7EA87E]/30 focus:outline-none focus:border-[#4EAA57]/40 font-mono resize-none"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[12px] border border-[#243224] text-[#7EA87E] hover:text-[#D6EDD0] hover:border-[#4EAA57]/30 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!json.trim() || createScan.isPending}
              className="flex-1 py-2 rounded-lg text-[12px] bg-[#4EAA57] text-white hover:bg-[#3D8B44] transition-colors disabled:opacity-40"
            >
              {createScan.isPending ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Run Scan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
