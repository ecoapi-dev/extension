import { useState } from 'react';
import { useParams } from 'react-router';
import { Search, Loader2, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useEndpoints } from '@/lib/queries';
import { formatCost } from '@/lib/format';
import type { EndpointStatus, EndpointRecord } from '@/lib/types';
import { Select } from '@/components/Select';

const statusConfig: Record<string, { color: string; dot: string; label: string }> = {
  'normal': { color: '#4EAA57', dot: 'bg-[#4EAA57]', label: 'normal' },
  'cacheable': { color: '#7EA87E', dot: 'bg-[#7EA87E]', label: 'cacheable' },
  'batchable': { color: '#5CBF65', dot: 'bg-[#5CBF65]', label: 'batchable' },
  'redundant': { color: '#B8A038', dot: 'bg-[#B8A038]', label: 'redundant' },
  'n_plus_one_risk': { color: '#C87F3A', dot: 'bg-[#C87F3A]', label: 'n+1 risk' },
  'rate_limit_risk': { color: '#C45A4A', dot: 'bg-[#C45A4A]', label: 'rate limit' },
};

const methodColors: Record<string, string> = {
  'GET': 'bg-[#2E6E34]/30 text-[#5CBF65]',
  'POST': 'bg-[#3A5E8C]/30 text-[#6CA0D0]',
  'DELETE': 'bg-[#6E2E2E]/30 text-[#C45A4A]',
  'PUT': 'bg-[#6E5E2E]/30 text-[#B8A038]',
  'PATCH': 'bg-[#4E3A6E]/30 text-[#9A7EC4]',
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#4EAA57',
  anthropic: '#E87D3E',
  stripe: '#7C3AED',
  supabase: '#3ECF8E',
  firebase: '#FFA000',
  sendgrid: '#1A82E2',
  twilio: '#F22F46',
};

const COST_MODEL_CONFIG: Record<string, { label: string; color: string }> = {
  per_token:      { label: 'token',  color: '#1A82E2' },
  per_transaction:{ label: 'txn',    color: '#7C3AED' },
  per_request:    { label: 'call',   color: 'rgba(255,255,255,0.4)' },
  free:           { label: 'free',   color: '#4EAA57' },
};

const FREQ_CONFIG: Record<string, { label: string; color: string; tooltip: string }> = {
  'bounded-loop':   { label: 'loop',     color: '#B8A038', tooltip: 'Inside a loop iterating over a collection' },
  'unbounded-loop': { label: 'loop ∞',   color: '#C45A4A', tooltip: 'Inside a loop with no fixed bound' },
  'parallel':       { label: 'parallel', color: '#1A82E2', tooltip: 'Runs in parallel via Promise.all or similar' },
  'polling':        { label: 'polling',  color: '#C45A4A', tooltip: 'Runs on a timer interval' },
  'conditional':    { label: 'if',       color: 'rgba(255,255,255,0.4)', tooltip: 'Inside a conditional branch' },
  'cache-guarded':  { label: 'cached',   color: '#4EAA57', tooltip: 'Guarded by a cache check' },
};

const COST_MODEL_TOOLTIPS: Record<string, string> = {
  per_token: 'Priced per input/output token',
  per_transaction: 'Fixed fee + percentage per transaction',
  per_request: 'Fixed price per API request',
  free: 'No charge for this call',
};

const allStatuses: (EndpointStatus | '')[] = ['', 'normal', 'cacheable', 'batchable', 'redundant', 'n_plus_one_risk', 'rate_limit_risk'];
const allCostModels = ['', 'per_token', 'per_transaction', 'per_request', 'free'];
const allFrequencies = ['', 'single', 'bounded-loop', 'unbounded-loop', 'parallel', 'polling', 'conditional', 'cache-guarded'];

function providerColor(p: string): string {
  return PROVIDER_COLORS[p.toLowerCase()] ?? 'rgba(255,255,255,0.45)';
}

function EndpointCard({ ep }: { ep: EndpointRecord }) {
  const [expanded, setExpanded] = useState(false);
  const sc = statusConfig[ep.status] ?? statusConfig['normal'];
  const mc = methodColors[ep.method.toUpperCase()] ?? methodColors['GET'];
  const scope = ep.scope ?? 'unknown';
  const pColor = providerColor(ep.provider);
  const costCfg = ep.costModel ? COST_MODEL_CONFIG[ep.costModel] : null;
  const freqCfg = ep.frequencyClass && ep.frequencyClass !== 'single' ? FREQ_CONFIG[ep.frequencyClass] : null;

  const caps: string[] = [];
  if (ep.streaming) caps.push('stream');
  if (ep.batchCapable) caps.push('batch');
  if (ep.inlineParallelCapable) caps.push('inline-parallel');
  if (ep.cacheCapable) caps.push('cache');
  if (ep.isMiddleware) caps.push('middleware');

  const costLabel = ep.costModel === 'free' ? 'Free' : formatCost(ep.monthlyCost);

  return (
    <div className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-2xl hover:border-white/[0.15] transition-colors overflow-hidden">
      <button className="w-full px-6 py-5 text-left" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className={`px-2.5 py-0.5 rounded text-[12px] tracking-wider ${mc}`}>
                {ep.method.toUpperCase()}
              </span>
              <code className="text-[14px] text-white truncate">{ep.url}</code>
              <span className="text-[11px] bg-white/[0.06] px-2 py-0.5 rounded capitalize" style={{ color: 'rgba(255,255,255,0.45)' }}>{scope}</span>
              <span className="text-[11px] px-2 py-0.5 rounded border" style={{ color: pColor, borderColor: pColor, background: `${pColor}18` }}>
                {ep.provider}
              </span>
              {costCfg && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border" title={ep.costModel ? COST_MODEL_TOOLTIPS[ep.costModel] : undefined} style={{ color: costCfg.color, borderColor: costCfg.color }}>
                  {costCfg.label}
                </span>
              )}
              {freqCfg && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border" title={freqCfg.tooltip} style={{ color: freqCfg.color, borderColor: freqCfg.color }}>
                  {freqCfg.label}
                </span>
              )}
              {caps.map((c) => (
                <span key={c} className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{c}</span>
              ))}
            </div>
            <div className="flex items-center gap-4 text-[12px] flex-wrap" style={{ color: 'rgba(255,255,255,0.35)' }}>
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${sc.dot}`} />
                <span style={{ color: sc.color }}>{sc.label}</span>
              </div>
              <span className="opacity-30">·</span>
              <span>{ep.files[0]}{ep.callSites[0] ? `:${ep.callSites[0].line}` : ''}</span>
              <span className="opacity-30">·</span>
              <span>{ep.callsPerDay.toLocaleString(undefined, { maximumFractionDigits: 0 })} calls/day</span>
              {ep.methodSignature && (
                <>
                  <span className="opacity-30">·</span>
                  <code className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{ep.methodSignature}</code>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <span className="text-[18px]" style={{ color: ep.costModel === 'free' ? '#4EAA57' : 'white' }}>
                {costLabel}
              </span>
              {ep.costModel !== 'free' && (
                <span className="text-[12px]" style={{ color: 'rgba(255,255,255,0.35)' }}>/mo</span>
              )}
            </div>
            <ChevronDown
              size={14}
              style={{
                color: 'rgba(255,255,255,0.3)',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
            />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/[0.06] px-6 py-4 space-y-3">
          {ep.crossFileOrigins && ep.crossFileOrigins.length > 0 && (
            <div>
              <p className="text-[11px] text-white/30 mb-1.5 uppercase tracking-wider">Cross-file origins</p>
              <div className="flex flex-wrap gap-2">
                {ep.crossFileOrigins.map((o, i) => (
                  <span key={i} className="text-[11px] bg-white/[0.05] border border-white/[0.08] rounded px-2 py-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
                    {o.functionName} <span style={{ color: 'rgba(255,255,255,0.3)' }}>in {o.file.split('/').pop() ?? o.file}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {ep.callSites.length > 0 && (
            <div>
              <p className="text-[11px] text-white/30 mb-1.5 uppercase tracking-wider">Call sites</p>
              <div className="space-y-1">
                {ep.callSites.map((cs, i) => {
                  const csFreq = cs.frequencyClass && cs.frequencyClass !== 'single' ? FREQ_CONFIG[cs.frequencyClass] : null;
                  return (
                    <div key={i} className="flex items-center gap-2 text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                      <code>{cs.file}:{cs.line}</code>
                      {csFreq && (
                        <span className="px-1.5 rounded border text-[10px]" style={{ color: csFreq.color, borderColor: csFreq.color }}>
                          {csFreq.label}
                        </span>
                      )}
                      {cs.crossFileOrigin && (
                        <span style={{ color: 'rgba(255,255,255,0.3)' }}>via {cs.crossFileOrigin.functionName}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Endpoints() {
  const { projectId } = useParams<{ projectId: string }>();
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [costModel, setCostModel] = useState('');
  const [frequencyClass, setFrequencyClass] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useEndpoints(projectId, {
    provider: provider || undefined,
    status: status || undefined,
    sort: 'monthly_cost',
    order: 'desc',
    page,
    limit: 20,
  });

  const endpoints = data?.data ?? [];
  const pagination = data?.pagination;

  const filtered = endpoints.filter((e) => {
    if (search && !e.url.toLowerCase().includes(search.toLowerCase()) && !e.files.some((f) => f.toLowerCase().includes(search.toLowerCase()))) return false;
    if (costModel && e.costModel !== costModel) return false;
    if (frequencyClass && e.frequencyClass !== frequencyClass) return false;
    return true;
  });

  const providerOptions = [...new Set(endpoints.map((e) => e.provider))];

  return (
    <div className="h-full overflow-auto scrollbar-hide">
    <div className="pt-14 px-8 pb-8 space-y-6 max-w-[1240px] mx-auto">
      <div>
        <h1 className="text-[26px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
          Endpoints
        </h1>
        <p className="text-[14px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
          {pagination ? `${pagination.total} API endpoints tracked` : 'Loading...'}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="flex-1 relative min-w-[200px]">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'rgba(255,255,255,0.35)' }} />
          <input
            type="text"
            placeholder="Search endpoints or files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-black/40 backdrop-blur-sm border border-white/[0.1] rounded-lg pl-11 pr-4 py-2.5 text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-[#4EAA57]/40 transition-colors"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          />
        </div>
        <Select
          value={provider}
          onChange={(v) => { setProvider(v); setPage(1); }}
          options={[
            { value: '', label: 'All Providers' },
            ...providerOptions.map((p) => ({ value: p, label: p })),
          ]}
        />
        <Select
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[
            { value: '', label: 'All Status' },
            ...allStatuses.filter(Boolean).map((s) => ({ value: s, label: statusConfig[s as EndpointStatus]?.label ?? s })),
          ]}
        />
        <Select
          value={costModel}
          onChange={(v) => { setCostModel(v); setPage(1); }}
          options={[
            { value: '', label: 'All Models' },
            ...allCostModels.filter(Boolean).map((m) => ({ value: m, label: COST_MODEL_CONFIG[m]?.label ?? m })),
          ]}
        />
        <Select
          value={frequencyClass}
          onChange={(v) => { setFrequencyClass(v); setPage(1); }}
          options={[
            { value: '', label: 'All Frequency' },
            ...allFrequencies.filter(Boolean).map((f) => ({ value: f, label: FREQ_CONFIG[f]?.label ?? f })),
          ]}
        />
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-[#4EAA57]" />
        </div>
      )}

      {!isLoading && (
        <div className="space-y-4">
          {filtered.map((ep) => <EndpointCard key={ep.id} ep={ep} />)}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20" style={{ color: 'rgba(255,255,255,0.35)' }}>
          <Search size={40} className="mb-4 opacity-30" />
          <p className="text-[14px]">No endpoints match your filters</p>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!pagination.hasPrev}
            className="p-2 rounded-md bg-black/40 border border-white/[0.08] transition-colors disabled:opacity-30"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-[13px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!pagination.hasNext}
            className="p-2 rounded-md bg-black/40 border border-white/[0.08] transition-colors disabled:opacity-30"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
    </div>
  );
}
