import { useState } from 'react';
import type { ElementType } from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, AlertCircle, Info, Leaf, RefreshCw, Layers, Zap, Archive, Loader2 } from 'lucide-react';
import { useSuggestions } from '@/lib/queries';
import { formatCost } from '@/lib/format';
import type { Severity, SuggestionType, Suggestion } from '@/lib/types';
import { Select } from '@/components/Select';

const severityConfig: Record<Severity, { color: string; bg: string; icon: ElementType; label: string }> = {
  high:   { color: '#C45A4A', bg: 'bg-[#C45A4A]/10', icon: AlertTriangle, label: 'HIGH IMPACT' },
  medium: { color: '#B8A038', bg: 'bg-[#B8A038]/10', icon: AlertCircle,   label: 'MEDIUM IMPACT' },
  low:    { color: '#7EA87E', bg: 'bg-[#7EA87E]/10', icon: Info,           label: 'LOW IMPACT' },
};

const typeIcons: Partial<Record<SuggestionType, ElementType>> = {
  cache:               Archive,
  batch:               Layers,
  unbatched_parallel:  Layers,
  redundancy:          RefreshCw,
  n_plus_one:          Layers,
  rate_limit:          Zap,
  concurrency_control: Zap,
};

const typeLabels: Record<string, string> = {
  cache:               'Cacheable',
  batch:               'Batchable',
  unbatched_parallel:  'Unbatched Parallel',
  redundancy:          'Redundant Call',
  n_plus_one:          'N+1 Query',
  rate_limit:          'Rate Limit Risk',
  concurrency_control: 'Concurrency',
};

const SOURCE_LABELS: Record<string, string> = {
  ai:           'AI',
  'local-rule': 'Rule',
  remote:       'Remote',
};

function confidenceColor(c: number): string {
  if (c >= 0.8) return '#4EAA57';
  if (c >= 0.6) return 'rgba(255,255,255,0.7)';
  if (c >= 0.4) return '#B8A038';
  return '#C45A4A';
}

export default function Suggestions() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useSuggestions(projectId, { limit: 100, sort: 'estimated_savings', order: 'desc' });

  const allSuggestions = data?.data ?? [];

  const [sourceFilter, setSourceFilter] = useState('');
  const [minConfidence, setMinConfidence] = useState(0);

  const suggestions = allSuggestions
    .filter((s) => !sourceFilter || s.source === sourceFilter)
    .filter((s) => typeof s.confidence !== 'number' || s.confidence >= minConfidence)
    .sort((a, b) => {
      const ca = a.confidence ?? -1;
      const cb = b.confidence ?? -1;
      if (cb !== ca) return cb - ca;
      return b.estimatedMonthlySavings - a.estimatedMonthlySavings;
    });

  const grouped: Record<Severity, Suggestion[]> = { high: [], medium: [], low: [] };
  suggestions.forEach((s) => grouped[s.severity].push(s));

  const totalSavings = suggestions.reduce((sum, s) => sum + s.estimatedMonthlySavings, 0);
  const sourcesPresent = [...new Set(allSuggestions.map((s) => s.source).filter(Boolean))] as string[];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="animate-spin text-[#4EAA57]" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto scrollbar-hide">
      <div className="pt-14 px-8 pb-8 space-y-6 max-w-[1240px] mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-[26px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
              Suggestions
            </h1>
            <p className="text-[14px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
              {suggestions.length} optimizations found · Save {formatCost(totalSavings)}/mo
            </p>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            {sourcesPresent.length > 1 && (
              <Select
                value={sourceFilter}
                onChange={setSourceFilter}
                options={[
                  { value: '', label: 'All Sources' },
                  ...sourcesPresent.map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? s })),
                ]}
              />
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Min confidence: {Math.round(minConfidence * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={minConfidence}
                onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                className="w-28 accent-[#4EAA57]"
              />
            </div>
          </div>
        </div>

        {suggestions.length === 0 && (
          <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-10 text-center">
            <p className="text-[14px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
              No suggestions match your filters.
            </p>
          </div>
        )}

        {(['high', 'medium', 'low'] as Severity[]).map((severity) => {
          const items = grouped[severity];
          if (items.length === 0) return null;
          const config = severityConfig[severity];

          return (
            <div key={severity} className="space-y-3">
              <div className="flex items-center gap-2.5 mb-2">
                <config.icon size={16} style={{ color: config.color }} />
                <span className="text-[13px] tracking-wider" style={{ color: config.color }}>{config.label}</span>
                <span className="text-[12px]" style={{ color: 'rgba(255,255,255,0.3)' }}>({items.length})</span>
              </div>

              {items.map((s) => {
                const TypeIcon = typeIcons[s.type] ?? Layers;
                const pct = typeof s.confidence === 'number' ? Math.round(s.confidence * 100) : null;
                return (
                  <div key={s.id} className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-6 hover:border-white/[0.15] transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2.5 mb-2 flex-wrap">
                          <div className={`p-1.5 rounded ${config.bg}`}>
                            <TypeIcon size={14} style={{ color: config.color }} />
                          </div>
                          <span className="text-[12px] uppercase tracking-wider" style={{ color: config.color }}>
                            {typeLabels[s.type] ?? s.type}
                          </span>
                          {s.source && (
                            <span
                              className="text-[10px] px-2 py-0.5 rounded border"
                              style={{ color: 'rgba(255,255,255,0.4)', borderColor: 'rgba(255,255,255,0.15)' }}
                            >
                              {SOURCE_LABELS[s.source] ?? s.source}
                            </span>
                          )}
                          {pct !== null && (
                            <span
                              className="text-[11px]"
                              title="How certain the detector is about this finding"
                              style={{ color: confidenceColor(s.confidence!) }}
                            >
                              {pct}% confidence
                            </span>
                          )}
                        </div>
                        <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'rgba(255,255,255,0.6)' }}>{s.description}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {s.affectedFiles.map((f) => (
                            <span key={f} className="text-[11px] bg-white/[0.05] px-2.5 py-1 rounded border border-white/[0.08]" style={{ color: 'rgba(255,255,255,0.45)' }}>{f}</span>
                          ))}
                        </div>
                        {s.codeFix && (
                          <pre className="mt-4 p-4 bg-black/60 rounded-lg border border-white/[0.06] overflow-x-auto">
                            <code className="text-[12px] leading-relaxed whitespace-pre" style={{ color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                              {s.codeFix}
                            </code>
                          </pre>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <div className="flex items-center gap-1.5 bg-[#4EAA57]/10 px-3 py-1.5 rounded-md border border-[#4EAA57]/20">
                          <Leaf size={13} className="text-[#4EAA57]" />
                          <span className="text-[13px] text-[#4EAA57]">{formatCost(s.estimatedMonthlySavings)}/mo</span>
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
    </div>
  );
}
