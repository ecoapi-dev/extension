import { useState } from 'react';
import { useParams } from 'react-router';
import { Search, ChevronDown, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEndpoints } from '@/lib/queries';
import type { EndpointStatus } from '@/lib/types';

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

const allStatuses: (EndpointStatus | '')[] = ['', 'normal', 'cacheable', 'batchable', 'redundant', 'n_plus_one_risk', 'rate_limit_risk'];

export default function Endpoints() {
  const { projectId } = useParams<{ projectId: string }>();
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
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

  const filtered = search
    ? endpoints.filter((e) =>
        e.url.toLowerCase().includes(search.toLowerCase()) ||
        e.files.some((f) => f.toLowerCase().includes(search.toLowerCase()))
      )
    : endpoints;

  const providerOptions = [...new Set(endpoints.map((e) => e.provider))];

  return (
    <div className="h-full overflow-auto scrollbar-hide">
    <div className="p-6 space-y-4 max-w-[960px] mx-auto">
      <div>
        <h1 className="text-[20px] text-white" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
          Endpoints
        </h1>
        <p className="text-[12px] mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
          {pagination ? `${pagination.total} API endpoints tracked` : 'Loading...'}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex gap-2 items-center">
        <div className="flex-1 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(255,255,255,0.35)' }} />
          <input
            type="text"
            placeholder="Search endpoints or files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-black/40 backdrop-blur-sm border border-white/[0.1] rounded-lg pl-9 pr-3 py-2 text-[12px] text-white placeholder:text-white/25 focus:outline-none focus:border-[#4EAA57]/40 transition-colors"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          />
        </div>
        <div className="relative">
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value); setPage(1); }}
            className="appearance-none bg-black/40 backdrop-blur-sm border border-white/[0.1] rounded-lg px-3 py-2 pr-8 text-[11px] text-white focus:outline-none focus:border-[#4EAA57]/40 cursor-pointer"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="">All Providers</option>
            {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'rgba(255,255,255,0.35)' }} />
        </div>
        <div className="relative">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="appearance-none bg-black/40 backdrop-blur-sm border border-white/[0.1] rounded-lg px-3 py-2 pr-8 text-[11px] text-white focus:outline-none focus:border-[#4EAA57]/40 cursor-pointer"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="">All Status</option>
            {allStatuses.filter(Boolean).map((s) => (
              <option key={s} value={s}>{statusConfig[s]?.label ?? s}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'rgba(255,255,255,0.35)' }} />
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-[#4EAA57]" />
        </div>
      )}

      {!isLoading && (
        <div className="space-y-2">
          {filtered.map((ep) => {
            const sc = statusConfig[ep.status] ?? statusConfig['normal'];
            const mc = methodColors[ep.method.toUpperCase()] ?? methodColors['GET'];
            return (
              <div key={ep.id} className="bg-black/40 backdrop-blur-sm border border-white/[0.08] rounded-xl p-4 hover:border-white/[0.15] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] tracking-wider ${mc}`}>
                        {ep.method.toUpperCase()}
                      </span>
                      <code className="text-[12px] text-white truncate">{ep.url}</code>
                      <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded capitalize" style={{ color: 'rgba(255,255,255,0.45)' }}>{ep.provider}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${sc.dot}`} />
                        <span style={{ color: sc.color }}>{sc.label}</span>
                      </div>
                      <span className="opacity-30">·</span>
                      <span>{ep.files[0]}{ep.callSites[0] ? `:${ep.callSites[0].line}` : ''}</span>
                      <span className="opacity-30">·</span>
                      <span>{ep.callsPerDay.toLocaleString(undefined, { maximumFractionDigits: 0 })} calls/day</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <span className="text-[14px] text-white">${ep.monthlyCost.toFixed(2)}</span>
                      <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>/mo</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16" style={{ color: 'rgba(255,255,255,0.35)' }}>
          <Search size={32} className="mb-3 opacity-30" />
          <p className="text-[12px]">No endpoints match your filters</p>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!pagination.hasPrev}
            className="p-1.5 rounded-md bg-black/40 border border-white/[0.08] transition-colors disabled:opacity-30"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!pagination.hasNext}
            className="p-1.5 rounded-md bg-black/40 border border-white/[0.08] transition-colors disabled:opacity-30"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
    </div>
  );
}
