import { useParams } from 'react-router';
import { AlertTriangle, AlertCircle, Info, Leaf, Sprout, RefreshCw, Layers, Zap, Archive, Loader2 } from 'lucide-react';
import { useSuggestions } from '@/lib/queries';
import type { Severity, SuggestionType, Suggestion } from '@/lib/types';

const severityConfig: Record<Severity, { color: string; border: string; bg: string; icon: React.ElementType; label: string }> = {
  high: { color: '#C45A4A', border: 'border-l-[#C45A4A]', bg: 'bg-[#C45A4A]/10', icon: AlertTriangle, label: 'HIGH IMPACT' },
  medium: { color: '#B8A038', border: 'border-l-[#B8A038]', bg: 'bg-[#B8A038]/10', icon: AlertCircle, label: 'MEDIUM IMPACT' },
  low: { color: '#7EA87E', border: 'border-l-[#7EA87E]', bg: 'bg-[#7EA87E]/10', icon: Info, label: 'LOW IMPACT' },
};

const typeIcons: Record<SuggestionType, React.ElementType> = {
  cache: Archive,
  batch: Layers,
  redundancy: RefreshCw,
  n_plus_one: Layers,
  rate_limit: Zap,
};

const typeLabels: Record<SuggestionType, string> = {
  cache: 'Cacheable',
  batch: 'Batchable',
  redundancy: 'Redundant Call',
  n_plus_one: 'N+1 Query',
  rate_limit: 'Rate Limit Risk',
};

export default function Suggestions() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useSuggestions(projectId, { limit: 100, sort: 'estimated_savings', order: 'desc' });

  const suggestions = data?.data ?? [];

  const grouped: Record<Severity, Suggestion[]> = { high: [], medium: [], low: [] };
  suggestions.forEach((s) => grouped[s.severity].push(s));

  const totalSavings = suggestions.reduce((sum, s) => sum + s.estimatedMonthlySavings, 0);

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
            Suggestions
          </h1>
          <p className="text-[12px] text-[#7EA87E] mt-1">
            {suggestions.length} optimizations found · Save ${totalSavings.toFixed(2)}/mo
          </p>
        </div>
      </div>

      {suggestions.length === 0 && (
        <div className="bg-[#131A13] border border-[#243224] rounded-xl p-8 text-center">
          <p className="text-[13px] text-[#7EA87E]">No suggestions found. Your API usage looks clean!</p>
        </div>
      )}

      {(['high', 'medium', 'low'] as Severity[]).map((severity) => {
        const items = grouped[severity];
        if (items.length === 0) return null;
        const config = severityConfig[severity];

        return (
          <div key={severity} className="space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <config.icon size={13} style={{ color: config.color }} />
              <span className="text-[11px] tracking-wider" style={{ color: config.color }}>{config.label}</span>
              <span className="text-[10px] text-[#7EA87E]/50">({items.length})</span>
            </div>

            {items.map((s) => {
              const TypeIcon = typeIcons[s.type] ?? Layers;
              return (
                <div key={s.id} className={`bg-[#131A13] border border-[#243224] border-l-[3px] ${config.border} rounded-xl p-4 hover:border-[#4EAA57]/20 transition-colors`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className={`p-1 rounded ${config.bg}`}>
                          <TypeIcon size={12} style={{ color: config.color }} />
                        </div>
                        <span className="text-[10px] uppercase tracking-wider" style={{ color: config.color }}>
                          {typeLabels[s.type] ?? s.type}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#7EA87E] leading-relaxed mb-2.5">{s.description}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        {s.affectedFiles.map((f) => (
                          <span key={f} className="text-[10px] bg-[#0B0F0B] text-[#7EA87E] px-2 py-0.5 rounded border border-[#243224]/50">{f}</span>
                        ))}
                      </div>
                      {s.codeFix && (
                        <pre className="mt-3 p-3 bg-[#080B08] rounded-lg border border-[#243224]/50 overflow-x-auto">
                          <code className="text-[10px] text-[#D6EDD0]/70 leading-relaxed whitespace-pre" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            {s.codeFix}
                          </code>
                        </pre>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <div className="flex items-center gap-1.5 bg-[#1C271C] px-2.5 py-1 rounded-md">
                        <Leaf size={11} className="text-[#4EAA57]" />
                        <span className="text-[11px] text-[#4EAA57]">${s.estimatedMonthlySavings.toFixed(2)}/mo</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
