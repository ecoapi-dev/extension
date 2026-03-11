import { X, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { SavedScenario } from '@/lib/types';

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

function DeltaBadge({ a, b }: { a: number; b: number }) {
  if (a === 0 && b === 0) return null;
  const pct = a > 0 ? ((b - a) / a) * 100 : 0;
  if (Math.abs(pct) < 0.5) {
    return (
      <span className="flex items-center gap-0.5 text-[10px] text-white/30">
        <Minus size={10} /> —
      </span>
    );
  }
  const higher = pct > 0;
  return (
    <span
      className={`flex items-center gap-0.5 text-[10px] font-medium ${higher ? 'text-[#C45A4A]' : 'text-[#4EAA57]'}`}
    >
      {higher ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {higher ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

function ScenarioCard({
  scenario,
  otherMonthlyCost,
}: {
  scenario: SavedScenario;
  otherMonthlyCost: number;
}) {
  const { input, result } = scenario;
  const inputSummary =
    input.mode === 'user-centric'
      ? `${fmtNum(input.dau ?? 0)} DAU · ${input.callsPerUserPerDay ?? 1} calls/user/day`
      : `${fmtNum(input.totalCallsPerDay ?? 0)} total calls/day`;

  return (
    <div className="bg-black/30 border border-white/[0.08] rounded-xl p-4 space-y-4 flex-1 min-w-0">
      {/* Label + date */}
      <div>
        <h3 className="text-[15px] font-semibold text-white truncate">{scenario.label}</h3>
        <p className="text-[11px] text-white/35 mt-0.5">{fmtDate(scenario.createdAt)}</p>
      </div>

      {/* Input params */}
      <div className="bg-black/20 rounded-lg p-3">
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Parameters</p>
        <p className="text-[12px] text-white/70">{inputSummary}</p>
        <p className="text-[11px] text-white/35 mt-0.5 capitalize">
          {input.mode === 'user-centric' ? 'Per-user mode' : 'Volume mode'}
        </p>
      </div>

      {/* Total cost */}
      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Monthly Cost</p>
        <div className="flex items-baseline gap-2">
          <p className="text-[20px] font-bold text-white">
            {fmtRange(result.totalMonthlyCost.low, result.totalMonthlyCost.high)}
          </p>
          <DeltaBadge a={otherMonthlyCost} b={result.totalMonthlyCost.mid} />
        </div>
        <p className="text-[11px] text-white/35 mt-0.5">
          Daily: {fmtRange(result.totalDailyCost.low, result.totalDailyCost.high)}
        </p>
      </div>

      {/* Provider breakdown */}
      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">By Provider</p>
        <div className="space-y-1.5">
          {result.byProvider.slice(0, 5).map((p) => (
            <div key={p.provider}>
              <div className="flex justify-between items-baseline mb-0.5">
                <span className="text-[11px] text-white/60 truncate">{p.provider}</span>
                <span className="text-[11px] text-white/80 shrink-0 ml-2">
                  {fmt(p.monthlyCost.mid)}/mo
                </span>
              </div>
              <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#4EAA57]/60 transition-all"
                  style={{ width: `${Math.min(100, p.percentOfTotal)}%` }}
                />
              </div>
            </div>
          ))}
          {result.byProvider.length > 5 && (
            <p className="text-[10px] text-white/25">+{result.byProvider.length - 5} more providers</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface ScenarioCompareProps {
  scenarios: [SavedScenario, SavedScenario];
  onClose: () => void;
}

export function ScenarioCompare({ scenarios, onClose }: ScenarioCompareProps) {
  const [a, b] = scenarios;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#0a0a0a] border border-white/[0.1] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08] sticky top-0 bg-[#0a0a0a] z-10">
          <h2 className="text-[15px] font-semibold text-white">Scenario Comparison</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white transition-colors p-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          <div className="flex gap-4">
            <ScenarioCard scenario={a} otherMonthlyCost={b.result.totalMonthlyCost.mid} />
            <div className="flex items-center justify-center shrink-0">
              <span className="text-[11px] text-white/20 font-medium">vs</span>
            </div>
            <ScenarioCard scenario={b} otherMonthlyCost={a.result.totalMonthlyCost.mid} />
          </div>

          {/* Summary delta row */}
          <div className="mt-5 bg-black/30 border border-white/[0.06] rounded-xl p-4">
            <p className="text-[11px] text-white/30 uppercase tracking-wider mb-3">Cost Difference</p>
            <div className="flex items-center justify-center gap-4">
              <div className="text-center">
                <p className="text-[12px] text-white/40">{a.label}</p>
                <p className="text-[16px] font-semibold text-white">{fmt(a.result.totalMonthlyCost.mid)}/mo</p>
              </div>
              <div className="text-center">
                {(() => {
                  const diff = b.result.totalMonthlyCost.mid - a.result.totalMonthlyCost.mid;
                  const pct = a.result.totalMonthlyCost.mid > 0
                    ? (diff / a.result.totalMonthlyCost.mid) * 100
                    : 0;
                  const higher = diff > 0;
                  return (
                    <div className={`text-[13px] font-bold ${higher ? 'text-[#C45A4A]' : diff < 0 ? 'text-[#4EAA57]' : 'text-white/30'}`}>
                      {diff === 0 ? '=' : `${higher ? '+' : ''}${fmt(Math.abs(diff))}`}
                      <p className="text-[10px] font-normal mt-0.5">
                        {Math.abs(pct) > 0.5 ? `${higher ? '+' : ''}${pct.toFixed(1)}%` : 'no change'}
                      </p>
                    </div>
                  );
                })()}
              </div>
              <div className="text-center">
                <p className="text-[12px] text-white/40">{b.label}</p>
                <p className="text-[16px] font-semibold text-white">{fmt(b.result.totalMonthlyCost.mid)}/mo</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
