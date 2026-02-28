import React from 'react';
import { motion as Motion } from 'motion/react';
import { Link, useNavigate } from 'react-router';
import { useTheme } from '../theme-context';
import { Particles } from '../components/particles';
import {
  Leaf,
  ArrowLeft,
  ArrowRight,
  Server,
  Code2,
  Zap,
  DollarSign,
  AlertTriangle,
  Globe,
  GitBranch,
  MessageSquare,
  Database,
  Cpu,
  List,
  FileText,
  Activity,
  Layers,
} from 'lucide-react';

// ─── Animation helper ────────────────────────────────────────────────────────

const FADE = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: 'easeOut' as const },
});

// ─── CodeBlock ───────────────────────────────────────────────────────────────

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        lineHeight: 1.7,
        backgroundColor: 'rgba(0,0,0,0.6)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '8px',
        padding: '14px 16px',
        overflowX: 'auto',
        color: 'rgba(255,255,255,0.75)',
        margin: 0,
        whiteSpace: 'pre',
      }}
    >
      <code>{children}</code>
    </pre>
  );
}

// ─── MethodBadge ─────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  GET:    { text: '#4ade80', bg: 'rgba(74,222,128,0.1)',  border: 'rgba(74,222,128,0.25)'  },
  POST:   { text: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.25)'  },
  PATCH:  { text: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.25)'  },
  DELETE: { text: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
};

function MethodBadge({ method }: { method: string }) {
  const c = METHOD_COLORS[method] ?? METHOD_COLORS.GET;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        fontWeight: 700,
        color: c.text,
        backgroundColor: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: '4px',
        padding: '2px 8px',
        letterSpacing: '0.05em',
        flexShrink: 0,
      }}
    >
      {method}
    </span>
  );
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ code, label }: { code: string; label: string }) {
  const isOk = code.startsWith('2');
  const color = isOk ? '#4ade80' : '#f87171';
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        color,
        backgroundColor: isOk ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
        border: `1px solid ${isOk ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
        borderRadius: '4px',
        padding: '2px 8px',
        marginRight: '6px',
      }}
    >
      {code} {label}
    </span>
  );
}

// ─── SubHeading ───────────────────────────────────────────────────────────────

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '10px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.3)',
        marginBottom: '8px',
        marginTop: '20px',
      }}
    >
      {children}
    </p>
  );
}

// ─── FieldTable ───────────────────────────────────────────────────────────────

type Field = { name: string; type: string; required?: boolean; desc: string };

function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {['Field', 'Type', 'Req', 'Description'].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,0.3)',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#60a5fa' }}>{f.name}</td>
              <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#fbbf24' }}>{f.type}</td>
              <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: f.required ? '#4ade80' : 'rgba(255,255,255,0.3)' }}>{f.required ? 'yes' : 'no'}</td>
              <td style={{ padding: '7px 10px', fontFamily: "'Inter', sans-serif", fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── DataTable (generic multi-column) ────────────────────────────────────────

function DataTable({ rows, headers }: { rows: string[][]; headers: string[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,0.3)',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '7px 10px',
                    fontFamily: j === 0 ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
                    fontSize: j === 0 ? '11px' : '12px',
                    color: j === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.45)',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── SectionCard ─────────────────────────────────────────────────────────────

function SectionCard({
  id,
  icon: Icon,
  badge,
  title,
  subtitle,
  delay,
  children,
}: {
  id: string;
  icon: React.ElementType;
  badge: string;
  title: string;
  subtitle: string;
  delay: number;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Motion.div
      id={id}
      {...FADE(delay)}
      className="rounded-2xl border p-8 backdrop-blur-xl scroll-mt-8"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderColor: 'rgba(255,255,255,0.08)' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <div
          className="flex items-center gap-2 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest"
          style={{
            background: `${theme.btnGradient[0]}22`,
            color: theme.btnGradient[0],
            border: `1px solid ${theme.btnGradient[0]}44`,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <Icon size={12} />
          {badge}
        </div>
      </div>
      <h2 className="text-[22px] text-white mb-1" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>
        {title}
      </h2>
      <p className="text-[13px] mb-5" style={{ color: theme.btnGradient[0], fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>
        {subtitle}
      </p>
      {children}
    </Motion.div>
  );
}

// ─── SectionLabel (group divider) ─────────────────────────────────────────────

function SectionLabel({
  id,
  icon: Icon,
  label,
  delay,
}: {
  id: string;
  icon: React.ElementType;
  label: string;
  delay: number;
}) {
  const theme = useTheme();
  return (
    <Motion.div id={id} {...FADE(delay)} className="flex items-center gap-3 pt-2 scroll-mt-8">
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] uppercase tracking-widest shrink-0"
        style={{
          background: `${theme.btnGradient[0]}18`,
          color: theme.btnGradient[0],
          border: `1px solid ${theme.btnGradient[0]}33`,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <Icon size={12} />
        {label}
      </div>
      <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
    </Motion.div>
  );
}

// ─── EndpointCard ─────────────────────────────────────────────────────────────

type EndpointCardProps = {
  id: string;
  method: string;
  path: string;
  description: string;
  requestFields?: Field[];
  requestExample?: string;
  queryParams?: Field[];
  responseStatuses?: { code: string; label: string }[];
  responseExample?: string;
  curl: string;
  delay: number;
};

function EndpointCard({
  id,
  method,
  path,
  description,
  requestFields,
  requestExample,
  queryParams,
  responseStatuses,
  responseExample,
  curl,
  delay,
}: EndpointCardProps) {
  return (
    <Motion.div
      id={id}
      {...FADE(delay)}
      className="rounded-2xl border p-6 backdrop-blur-xl scroll-mt-8"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderColor: 'rgba(255,255,255,0.08)' }}
    >
      {/* Method + Path */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <MethodBadge method={method} />
        <code
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '14px',
            color: 'rgba(255,255,255,0.9)',
            wordBreak: 'break-all',
          }}
        >
          {path}
        </code>
      </div>

      {/* Description */}
      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: '4px' }}>
        {description}
      </p>

      {/* Query Params */}
      {queryParams && queryParams.length > 0 && (
        <>
          <SubHeading>Query Parameters</SubHeading>
          <FieldTable fields={queryParams} />
        </>
      )}

      {/* Request Body */}
      {requestFields && requestFields.length > 0 && (
        <>
          <SubHeading>Request Body</SubHeading>
          <FieldTable fields={requestFields} />
        </>
      )}
      {requestExample && (
        <div style={{ marginTop: '10px' }}>
          <CodeBlock>{requestExample}</CodeBlock>
        </div>
      )}

      {/* Response */}
      {(responseStatuses || responseExample) && (
        <>
          <SubHeading>Response</SubHeading>
          {responseStatuses && (
            <div style={{ marginBottom: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {responseStatuses.map((s) => (
                <StatusBadge key={s.code} code={s.code} label={s.label} />
              ))}
            </div>
          )}
          {responseExample && <CodeBlock>{responseExample}</CodeBlock>}
        </>
      )}

      {/* Example curl */}
      <SubHeading>Example</SubHeading>
      <CodeBlock>{curl}</CodeBlock>
    </Motion.div>
  );
}

// ─── TOC Sidebar ─────────────────────────────────────────────────────────────

const TOC_SECTIONS = [
  {
    label: 'Getting Started',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'setup', label: 'Base URL & Setup' },
    ],
  },
  {
    label: 'API Reference',
    items: [
      { id: 'health', label: 'Health' },
      { id: 'projects', label: 'Projects' },
      { id: 'scans', label: 'Scans' },
      { id: 'endpoints-api', label: 'Endpoints' },
      { id: 'suggestions', label: 'Suggestions' },
      { id: 'graph', label: 'Graph' },
      { id: 'cost', label: 'Cost Analytics' },
      { id: 'sustainability', label: 'Sustainability' },
      { id: 'providers', label: 'Providers' },
      { id: 'chat', label: 'Chat' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { id: 'request-format', label: 'Request Format' },
      { id: 'limits', label: 'Rate Limits' },
      { id: 'response-format', label: 'Response Format' },
      { id: 'workflow', label: 'Example Workflow' },
      { id: 'pricing', label: 'Pricing Table' },
      { id: 'frequency', label: 'Frequency Heuristics' },
    ],
  },
];

function TOCSidebar() {
  const theme = useTheme();
  return (
    <nav
      className="flex-1 flex flex-col min-h-0 overflow-y-auto"
      style={{ width: '100%', minWidth: '280px' }}
    >
      <p
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '18px',
          fontWeight: 600,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.65)',
          marginBottom: '14px',
        }}
      >
        Contents
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {TOC_SECTIONS.map((section, sectionIndex) => (
          <div key={section.label}>
            <p
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                fontWeight: 600,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.65)',
                marginTop: sectionIndex === 0 ? 0 : '18px',
                marginBottom: '10px',
              }}
            >
              {section.label}
            </p>
            {section.items.map(({ id, label }) => (
              <a
                key={id}
                href={`#${id}`}
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '15px',
                  color: 'rgba(255,255,255,0.3)',
                  textDecoration: 'none',
                  padding: '6px 10px 6px 16px',
                  borderRadius: '8px',
                  display: 'block',
                  transition: 'color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = theme.btnGradient[0];
                  (e.currentTarget as HTMLAnchorElement).style.background = `${theme.btnGradient[0]}10`;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.3)';
                  (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                }}
              >
                {label}
              </a>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Docs() {
  const theme = useTheme();
  const navigate = useNavigate();

  return (
    <div className="relative w-full h-screen overflow-hidden flex flex-col" style={{ backgroundColor: theme.bg }}>
      {/* Background */}
      <div className="absolute inset-0 z-0" style={{ background: theme.skyGradient }} />
      <div className="absolute inset-0 z-[1] pointer-events-none" style={{ background: 'rgba(0,0,0,0.65)' }} />
      <Particles />

      {/* Top bar — sticky, never scrolls */}
      <header
        className="sticky top-0 z-20 flex-shrink-0 flex items-center justify-between px-8 pt-8 pb-4"
        style={{
          backgroundColor: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Link
          to="/"
          className="flex items-center gap-2 text-[12px] transition-colors"
          style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          <ArrowLeft size={14} />
          Back
        </Link>
        <div className="flex items-center gap-2">
          <Leaf size={18} className="text-[#4EAA57]" strokeWidth={2.5} />
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
            EcoApi
          </span>
        </div>
      </header>

      {/* Body: TOC (fixed) + scrollable main */}
      <div className="flex flex-1 min-h-0 relative z-10">
        {/* Left: TOC sidebar — fills full height between header and bottom */}
        <aside
          className="hidden md:flex flex-col shrink-0 pl-4 pr-2 pt-6 w-[320px] self-stretch"
          style={{
            backgroundColor: 'rgba(0,0,0,0.35)',
            borderRight: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <TOCSidebar />
        </aside>

        {/* Right: scrollable content */}
        <main className="flex-1 overflow-y-auto min-w-0">
          <div className="px-2 pb-24 max-w-5xl mx-auto">
            {/* Hero */}
            <Motion.div {...FADE(0)} className="text-center px-4 pt-10 pb-12">
              <h1
                className="text-[48px] md:text-[64px] text-white mb-4"
                style={{ fontFamily: "'Playfair Display', serif", fontWeight: 900, lineHeight: 1.05 }}
              >
                API Docs
              </h1>
              <p
                className="text-[16px] max-w-2xl mx-auto"
                style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter', sans-serif", lineHeight: 1.7 }}
              >
                Complete reference for every EcoApi endpoint — request shapes, response formats, rate limits, and curl examples.
              </p>
            </Motion.div>

            {/* Main content */}
            <div className="space-y-5">

              {/* ── 1. Overview ─────────────────────────────────────── */}
              <SectionCard id="overview" icon={Zap} badge="Overview" title="What is EcoApi?" subtitle="Analyze · Estimate · Optimize · Sustainability" delay={0.05}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '12px' }}>
                  EcoApi is a REST API that turns parsed API call data from your codebase into actionable diagnostics.
                  Send a list of outbound HTTP calls found in your source files and the engine detects inefficiencies,
                  estimates monthly costs per provider, surfaces N+1 and rate-limit hotspots, and generates code-level
                  optimization suggestions with estimated savings.
                </p>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7 }}>
                  EcoApi also computes <strong style={{ color: 'rgba(255,255,255,0.8)' }}>sustainability stats</strong> — electricity (kWh),
                  water (L), and CO₂ (g) footprint estimated from API call volume, with an AI vs non-AI breakdown, so your
                  team can measure the environmental cost of every API call.
                </p>
              </SectionCard>

              {/* ── 2. Setup ────────────────────────────────────────── */}
              <SectionCard id="setup" icon={Server} badge="Setup" title="Base URL & Setup" subtitle="Cloudflare Workers · Hono · D1 SQLite" delay={0.07}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                  {[
                    { label: 'Local dev',     value: 'http://localhost:8787' },
                    { label: 'Production',    value: 'https://your-worker.workers.dev' },
                    { label: 'Content-Type',  value: 'application/json (required)' },
                    { label: 'Start dev',     value: 'cd api && npm run dev' },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '12px 14px' }}
                    >
                      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '4px' }}>{label}</p>
                      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.75)' }}>{value}</p>
                    </div>
                  ))}
                </div>
                <SubHeading>Quick start</SubHeading>
                <CodeBlock>{`cd api
npm install
npx wrangler d1 create eco-db          # create D1 database
# paste returned database_id into api/wrangler.toml
npx wrangler kv namespace create rate-limit
# paste returned id + preview_id into wrangler.toml [[kv_namespaces]]
npm run db:migrate:local                # apply schema + seed data
npm run dev                             # → http://localhost:8787`}</CodeBlock>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginTop: '10px', lineHeight: 1.6 }}>
                  All responses carry CORS headers and an <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>X-Request-Id</code> header.
                </p>
              </SectionCard>

              {/* ── 3. Health ───────────────────────────────────────── */}
              <SectionLabel id="health" icon={Activity} label="Health" delay={0.08} />

              <EndpointCard
                id="health-get"
                method="GET"
                path="/health"
                description="Server health check. Returns current status and a UTC timestamp. Use this to verify the worker is running before submitting scan data."
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "status": "ok",
  "timestamp": "2025-01-15T12:00:00.000Z"
}`}
                curl={`curl https://your-worker.workers.dev/health`}
                delay={0.09}
              />

              {/* ── 4. Projects ─────────────────────────────────────── */}
              <SectionLabel id="projects" icon={Database} label="Projects" delay={0.1} />

              <EndpointCard
                id="projects-post"
                method="POST"
                path="/projects"
                description="Create a new project. Projects are the top-level container for scans, endpoints, and suggestions. Returns the created project with a generated UUID."
                requestFields={[
                  { name: 'name',        type: 'string', required: true,  desc: 'Human-readable project name' },
                  { name: 'description', type: 'string', required: false, desc: 'Optional project description' },
                ]}
                requestExample={`{
  "name": "my-app",
  "description": "Production API analysis"
}`}
                responseStatuses={[{ code: '201', label: 'Created' }, { code: '422', label: 'Validation Error' }]}
                responseExample={`{
  "data": {
    "id": "a1b2c3d4-...",
    "name": "my-app",
    "description": "Production API analysis",
    "created_at": "2025-01-15T12:00:00.000Z",
    "updated_at": "2025-01-15T12:00:00.000Z",
    "latest_scan_id": null
  }
}`}
                curl={`curl -X POST https://your-worker.workers.dev/projects \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-app"}'`}
                delay={0.11}
              />

              <EndpointCard
                id="projects-list"
                method="GET"
                path="/projects"
                description="List all projects with pagination. Supports filtering by name and sorting by any top-level field."
                queryParams={[
                  { name: 'page',  type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit', type: 'number', desc: 'Items per page (default: 20)' },
                  { name: 'name',  type: 'string', desc: 'Filter by project name (partial match)' },
                  { name: 'sort',  type: 'string', desc: 'Sort field: created_at | updated_at | name' },
                  { name: 'order', type: 'string', desc: 'Sort direction: asc | desc' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [{ "id": "...", "name": "my-app", ... }],
  "pagination": {
    "page": 1, "limit": 20, "total": 3,
    "totalPages": 1, "hasNext": false, "hasPrev": false
  }
}`}
                curl={`curl "https://your-worker.workers.dev/projects?page=1&limit=20&sort=created_at&order=desc"`}
                delay={0.12}
              />

              <EndpointCard
                id="projects-get"
                method="GET"
                path="/projects/:id"
                description="Retrieve a single project by its UUID. Returns 404 if the project does not exist."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{
  "data": {
    "id": "a1b2c3d4-...",
    "name": "my-app",
    "description": null,
    "created_at": "2025-01-15T12:00:00.000Z",
    "updated_at": "2025-01-15T12:01:00.000Z",
    "latest_scan_id": "s9f8e7d6-..."
  }
}`}
                curl={`curl https://your-worker.workers.dev/projects/a1b2c3d4-...`}
                delay={0.13}
              />

              <EndpointCard
                id="projects-patch"
                method="PATCH"
                path="/projects/:id"
                description="Update a project's name or description. Only fields provided in the body are modified (partial update)."
                requestFields={[
                  { name: 'name',        type: 'string', desc: 'New project name' },
                  { name: 'description', type: 'string', desc: 'New description (pass null to clear)' },
                ]}
                requestExample={`{ "name": "my-app-v2" }`}
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{ "data": { "id": "...", "name": "my-app-v2", ... } }`}
                curl={`curl -X PATCH https://your-worker.workers.dev/projects/a1b2c3d4-... \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-app-v2"}'`}
                delay={0.14}
              />

              <EndpointCard
                id="projects-delete"
                method="DELETE"
                path="/projects/:id"
                description="Delete a project and all its associated data (scans, endpoints, suggestions) in a cascading batch operation. Returns 204 No Content on success."
                responseStatuses={[{ code: '204', label: 'No Content' }, { code: '404', label: 'Not Found' }]}
                curl={`curl -X DELETE https://your-worker.workers.dev/projects/a1b2c3d4-...`}
                delay={0.15}
              />

              {/* ── 5. Scans ────────────────────────────────────────── */}
              <SectionLabel id="scans" icon={Layers} label="Scans" delay={0.16} />

              <EndpointCard
                id="scans-post"
                method="POST"
                path="/projects/:id/scans"
                description="Submit a new scan for a project. Provide an array of API calls extracted from your source code. The engine analyzes them synchronously and persists endpoints, suggestions, and graph data. Max 2,000 apiCalls per request; max 10 scans per 60 seconds per project."
                requestFields={[
                  { name: 'apiCalls', type: 'ApiCall[]', required: true, desc: 'Array of API calls found in source code (max 2,000)' },
                ]}
                requestExample={`{
  "apiCalls": [
    {
      "file": "src/checkout.ts",
      "line": 47,
      "method": "GET",
      "url": "https://api.stripe.com/v1/customers",
      "library": "axios",
      "frequency": "per-request"
    },
    {
      "file": "src/notify.ts",
      "line": 12,
      "method": "POST",
      "url": "https://api.sendgrid.com/v3/mail/send",
      "library": "fetch",
      "frequency": "1200/day"
    }
  ]
}`}
                responseStatuses={[
                  { code: '201', label: 'Created' },
                  { code: '422', label: 'Validation Error' },
                  { code: '429', label: 'Rate Limited' },
                ]}
                responseExample={`{
  "data": {
    "id": "s9f8e7d6-...",
    "project_id": "a1b2c3d4-...",
    "created_at": "2025-01-15T12:00:00.000Z",
    "summary": {
      "totalEndpoints": 2,
      "totalMonthlyCost": 87.60,
      "totalSuggestions": 1,
      "highSeverityCount": 1
    }
  }
}`}
                curl={`curl -X POST https://your-worker.workers.dev/projects/{projectId}/scans \\
  -H "Content-Type: application/json" \\
  -d '{
    "apiCalls": [{
      "file": "src/main.ts",
      "line": 21,
      "method": "GET",
      "url": "https://api.stripe.com/v1/customers",
      "library": "fetch",
      "frequency": "1200/day"
    }]
  }'`}
                delay={0.17}
              />

              <EndpointCard
                id="scans-list"
                method="GET"
                path="/projects/:id/scans"
                description="List all scans for a project in reverse-chronological order by default."
                queryParams={[
                  { name: 'page',  type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit', type: 'number', desc: 'Items per page (default: 20)' },
                  { name: 'sort',  type: 'string', desc: 'Sort field: created_at' },
                  { name: 'order', type: 'string', desc: 'asc | desc (default: desc)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [{ "id": "s9f8e7d6-...", "created_at": "...", "summary": { ... } }],
  "pagination": { "page": 1, "limit": 20, "total": 5, ... }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/scans?sort=created_at&order=desc"`}
                delay={0.18}
              />

              <EndpointCard
                id="scans-latest"
                method="GET"
                path="/projects/:id/scans/latest"
                description="Retrieve the most recent scan for a project. Returns 404 if no scans exist yet."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{
  "data": {
    "id": "s9f8e7d6-...",
    "project_id": "a1b2c3d4-...",
    "created_at": "2025-01-15T12:00:00.000Z",
    "summary": {
      "totalEndpoints": 12,
      "totalMonthlyCost": 142.80,
      "totalSuggestions": 4,
      "highSeverityCount": 2
    }
  }
}`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/scans/latest`}
                delay={0.19}
              />

              <EndpointCard
                id="scans-get"
                method="GET"
                path="/projects/:id/scans/:scanId"
                description="Retrieve a specific scan by its ID, including its summary statistics."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{ "data": { "id": "s9f8e7d6-...", "summary": { ... }, ... } }`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/scans/{scanId}`}
                delay={0.2}
              />

              {/* ── 6. Endpoints ────────────────────────────────────── */}
              <SectionLabel id="endpoints-api" icon={Globe} label="Endpoints" delay={0.21} />

              <EndpointCard
                id="endpoints-list"
                method="GET"
                path="/projects/:id/endpoints"
                description="List all API endpoints detected across a project's scans. Rich filtering by provider, HTTP status, method; sort by monthly cost."
                queryParams={[
                  { name: 'provider', type: 'string', desc: 'Filter by provider name (e.g. stripe, openai)' },
                  { name: 'status',   type: 'string', desc: 'Filter: normal | cacheable | n+1 | redundant | rate-limited' },
                  { name: 'method',   type: 'string', desc: 'HTTP method: GET | POST | PUT | PATCH | DELETE' },
                  { name: 'sort',     type: 'string', desc: 'Sort field: monthly_cost | calls_per_day | provider | method' },
                  { name: 'order',    type: 'string', desc: 'asc | desc (default: desc)' },
                  { name: 'page',     type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit',    type: 'number', desc: 'Items per page (default: 20)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [
    {
      "id": "e1a2b3c4-...",
      "project_id": "a1b2c3d4-...",
      "scan_id": "s9f8e7d6-...",
      "provider": "stripe",
      "method": "GET",
      "url": "https://api.stripe.com/v1/customers",
      "files": ["src/checkout.ts"],
      "call_sites": [{ "file": "src/checkout.ts", "line": 47 }],
      "calls_per_day": 1000,
      "monthly_cost": 300.00,
      "status": "n+1"
    }
  ],
  "pagination": { ... }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/endpoints?provider=stripe&status=n%2B1&sort=monthly_cost&order=desc"`}
                delay={0.22}
              />

              <EndpointCard
                id="endpoints-get"
                method="GET"
                path="/projects/:id/endpoints/:endpointId"
                description="Retrieve a single endpoint by ID, including all call sites (file + line) and full cost details."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{
  "data": {
    "id": "e1a2b3c4-...",
    "provider": "stripe",
    "method": "GET",
    "url": "https://api.stripe.com/v1/customers",
    "files": ["src/checkout.ts", "src/billing.ts"],
    "call_sites": [
      { "file": "src/checkout.ts", "line": 47 },
      { "file": "src/billing.ts",  "line": 23 }
    ],
    "calls_per_day": 1000,
    "monthly_cost": 300.00,
    "status": "n+1"
  }
}`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/endpoints/{endpointId}`}
                delay={0.23}
              />

              {/* ── 7. Suggestions ──────────────────────────────────── */}
              <SectionLabel id="suggestions" icon={AlertTriangle} label="Suggestions" delay={0.24} />

              <EndpointCard
                id="suggestions-list"
                method="GET"
                path="/projects/:id/suggestions"
                description="List optimization suggestions from the latest scan. Filter by type or severity; sort by estimated monthly savings."
                queryParams={[
                  { name: 'type',     type: 'string', desc: 'Comma-separated: cache | batch | deduplicate | rate-limit | n+1' },
                  { name: 'severity', type: 'string', desc: 'Filter by severity: high | medium | low' },
                  { name: 'sort',     type: 'string', desc: 'Sort field: estimated_monthly_savings | severity | type' },
                  { name: 'order',    type: 'string', desc: 'asc | desc (default: desc)' },
                  { name: 'page',     type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit',    type: 'number', desc: 'Items per page (default: 20)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [
    {
      "id": "sg1a2b3c-...",
      "type": "cache",
      "severity": "high",
      "description": "GET /v1/customers is called 1000x/day but results are identical per session.",
      "code_fix": "const cache = new Map();\nasync function getCustomer(id) {\n  if (cache.has(id)) return cache.get(id);\n  ...\n}",
      "affected_endpoints": ["e1a2b3c4-..."],
      "affected_files": ["src/checkout.ts"],
      "estimated_monthly_savings": 240.00
    }
  ],
  "pagination": { ... }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/suggestions?severity=high&sort=estimated_monthly_savings&order=desc"`}
                delay={0.25}
              />

              <EndpointCard
                id="suggestions-get"
                method="GET"
                path="/projects/:id/suggestions/:suggestionId"
                description="Retrieve a single suggestion including the full code_fix snippet and affected endpoints."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{ "data": { "id": "sg1a2b3c-...", "type": "cache", "severity": "high", ... } }`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/suggestions/{suggestionId}`}
                delay={0.26}
              />

              {/* ── 8. Graph ────────────────────────────────────────── */}
              <SectionLabel id="graph" icon={GitBranch} label="Graph" delay={0.27} />

              <EndpointCard
                id="graph-get"
                method="GET"
                path="/projects/:id/graph"
                description="Returns graph data representing the file → endpoint dependency structure from the latest scan. The cluster_by parameter controls node grouping for visualization."
                queryParams={[
                  { name: 'cluster_by', type: 'string', desc: 'Grouping: provider | file | cost (default: provider)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": {
    "nodes": [
      { "id": "src/checkout.ts", "type": "file",     "label": "checkout.ts" },
      { "id": "stripe",          "type": "provider", "label": "Stripe" }
    ],
    "edges": [
      { "source": "src/checkout.ts", "target": "stripe", "weight": 1000 }
    ]
  }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/graph?cluster_by=provider"`}
                delay={0.28}
              />

              {/* ── 9. Cost Analytics ───────────────────────────────── */}
              <SectionLabel id="cost" icon={DollarSign} label="Cost Analytics" delay={0.29} />

              <EndpointCard
                id="cost-get"
                method="GET"
                path="/projects/:id/cost"
                description="Top-level cost summary for the project: total monthly cost, daily cost, and per-provider breakdown from the latest scan."
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": {
    "totalMonthlyCost": 412.50,
    "totalDailyCost": 13.75,
    "totalCallsPerDay": 2750,
    "byProvider": [
      { "provider": "stripe", "monthlyCost": 300.00, "callsPerDay": 1000 },
      { "provider": "openai", "monthlyCost": 112.50, "callsPerDay": 1750 }
    ]
  }
}`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/cost`}
                delay={0.3}
              />

              <EndpointCard
                id="cost-by-provider"
                method="GET"
                path="/projects/:id/cost/by-provider"
                description="Paginated cost breakdown grouped by provider, sorted by monthly cost descending by default."
                queryParams={[
                  { name: 'page',  type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit', type: 'number', desc: 'Items per page (default: 20)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [
    { "provider": "stripe", "monthlyCost": 300.00, "callsPerDay": 1000, "endpointCount": 3 },
    { "provider": "openai", "monthlyCost": 112.50, "callsPerDay": 1750, "endpointCount": 2 }
  ],
  "pagination": { ... }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/cost/by-provider?page=1&limit=20"`}
                delay={0.31}
              />

              <EndpointCard
                id="cost-by-file"
                method="GET"
                path="/projects/:id/cost/by-file"
                description="Paginated cost breakdown grouped by source file — identify which files are responsible for the most API spend."
                queryParams={[
                  { name: 'page',  type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit', type: 'number', desc: 'Items per page (default: 20)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [
    { "file": "src/checkout.ts",    "monthlyCost": 300.00, "callsPerDay": 1000 },
    { "file": "src/ai-assistant.ts","monthlyCost": 112.50, "callsPerDay": 1750 }
  ],
  "pagination": { ... }
}`}
                curl={`curl "https://your-worker.workers.dev/projects/{projectId}/cost/by-file?page=1&limit=20"`}
                delay={0.32}
              />

              {/* ── 10. Sustainability ──────────────────────────────── */}
              <SectionLabel id="sustainability" icon={Leaf} label="Sustainability" delay={0.33} />

              <EndpointCard
                id="sustainability-get"
                method="GET"
                path="/projects/:id/sustainability"
                description="Estimated environmental impact from the project's latest scan: electricity (kWh), water (L), and CO₂ (g) with an AI vs non-AI breakdown per provider."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'No scans yet' }]}
                responseExample={`{
  "data": {
    "electricity": { "dailyKwh": 4.5,    "monthlyKwh": 135.0   },
    "water":       { "dailyLiters": 8.1,  "monthlyLiters": 243.0 },
    "co2":         { "dailyGrams": 1737.0, "monthlyGrams": 52110.0 },
    "aiCallsPerDay": 1500,
    "totalCallsPerDay": 1501,
    "aiCallsPercentage": 99.9,
    "byProvider": [
      {
        "provider": "openai",
        "isAi": true,
        "callsPerDay": 1500,
        "dailyKwh": 4.5,
        "dailyWaterLiters": 8.1,
        "dailyCo2Grams": 1737.0
      },
      {
        "provider": "stripe",
        "isAi": false,
        "callsPerDay": 1,
        "dailyKwh": 0.00002,
        "dailyWaterLiters": 0.000036,
        "dailyCo2Grams": 0.007720
      }
    ]
  }
}`}
                curl={`curl https://your-worker.workers.dev/projects/{projectId}/sustainability`}
                delay={0.34}
              />

              {/* Energy constants table */}
              <Motion.div {...FADE(0.35)} className="rounded-2xl border p-6 backdrop-blur-xl" style={{ backgroundColor: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.08)' }}>
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '12px' }}>
                  Energy constants — api/src/config/sustainability.ts
                </p>
                <DataTable
                  headers={['Provider', 'kWh / call', 'AI?']}
                  rows={[
                    ['OpenAI',            '0.003000',  'Yes'],
                    ['Google Maps',       '0.000030',  'No'],
                    ['Stripe',            '0.000020',  'No'],
                    ['Twilio',            '0.000010',  'No'],
                    ['AWS S3',            '0.000008',  'No'],
                    ['SendGrid/Internal', '0.000005',  'No'],
                  ]}
                />
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '12px', lineHeight: 1.6 }}>
                  Water intensity: <strong style={{ color: 'rgba(255,255,255,0.5)' }}>1.8 L/kWh</strong> (Microsoft Azure data center disclosures) ·
                  CO₂ intensity: <strong style={{ color: 'rgba(255,255,255,0.5)' }}>386 g/kWh</strong> (US EPA eGRID 2022 national average)
                </p>
              </Motion.div>

              {/* ── 11. Providers ───────────────────────────────────── */}
              <SectionLabel id="providers" icon={Server} label="Providers" delay={0.36} />

              <EndpointCard
                id="providers-list"
                method="GET"
                path="/providers"
                description="List all supported API providers with their pricing configuration, URL detection keywords, and sustainability constants."
                queryParams={[
                  { name: 'page',  type: 'number', desc: 'Page number (default: 1)' },
                  { name: 'limit', type: 'number', desc: 'Items per page (default: 20)' },
                ]}
                responseStatuses={[{ code: '200', label: 'OK' }]}
                responseExample={`{
  "data": [
    { "name": "stripe", "costPerCall": 0.01,  "keywords": ["stripe.com"] },
    { "name": "openai", "costPerCall": 0.006, "keywords": ["openai.com"] }
  ],
  "pagination": { ... }
}`}
                curl={`curl https://your-worker.workers.dev/providers`}
                delay={0.37}
              />

              <EndpointCard
                id="providers-get"
                method="GET"
                path="/providers/:name"
                description="Retrieve configuration for a specific provider by slug name (e.g. stripe, openai, twilio, sendgrid, aws-s3, google-maps)."
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '404', label: 'Not Found' }]}
                responseExample={`{
  "data": {
    "name": "stripe",
    "costPerCall": 0.01,
    "keywords": ["stripe.com", "api.stripe.com"],
    "energyKwhPerCall": 0.00002,
    "isAi": false
  }
}`}
                curl={`curl https://your-worker.workers.dev/providers/stripe`}
                delay={0.38}
              />

              {/* ── 12. Chat ────────────────────────────────────────── */}
              <SectionLabel id="chat" icon={MessageSquare} label="Chat" delay={0.39} />

              <EndpointCard
                id="chat-post"
                method="POST"
                path="/chat"
                description="AI chat endpoint. Send a natural-language message and optional project context to receive optimization advice, code explanations, or cost analysis from the AI assistant."
                requestFields={[
                  { name: 'message',   type: 'string', required: true,  desc: 'The user message or question' },
                  { name: 'projectId', type: 'string', required: false, desc: 'Project ID to include project context in the prompt' },
                  { name: 'context',   type: 'object', required: false, desc: 'Additional context (endpoint data, suggestion, etc.)' },
                ]}
                requestExample={`{
  "message": "Why is the Stripe endpoint flagged as N+1?",
  "projectId": "a1b2c3d4-..."
}`}
                responseStatuses={[{ code: '200', label: 'OK' }, { code: '422', label: 'Validation Error' }]}
                responseExample={`{
  "data": {
    "reply": "The Stripe GET /v1/customers endpoint is called once per user request inside a loop, resulting in N API calls instead of one batched lookup. Cache results per session or use the Stripe customer list endpoint to fix this."
  }
}`}
                curl={`curl -X POST https://your-worker.workers.dev/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Why is the Stripe endpoint flagged as N+1?","projectId":"a1b2c3d4-..."}'`}
                delay={0.4}
              />

              {/* ── 13. Request Format ──────────────────────────────── */}
              <SectionCard id="request-format" icon={Code2} badge="Request Format" title="ApiCall Schema" subtitle="POST /projects/:id/scans → body.apiCalls[]" delay={0.41}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '14px' }}>
                  Each element of the <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>apiCalls</code> array represents one outbound HTTP call found in source code.
                  The scanner (extension or CI script) extracts these and POSTs them to EcoApi.
                </p>
                <FieldTable fields={[
                  { name: 'file',      type: 'string',          required: true,  desc: 'Relative path to the source file containing the call' },
                  { name: 'line',      type: 'number',          required: true,  desc: 'Line number where the HTTP call appears' },
                  { name: 'method',    type: 'string',          required: true,  desc: 'HTTP verb: GET | POST | PUT | PATCH | DELETE | etc.' },
                  { name: 'url',       type: 'string',          required: true,  desc: 'Full URL or path pattern of the endpoint being called' },
                  { name: 'library',   type: 'string',          required: true,  desc: 'HTTP library: fetch | axios | requests | got | urllib | etc.' },
                  { name: 'frequency', type: 'string | number', required: false, desc: '"per-request" | "per-session" | "daily" | "1200/day" | number' },
                ]} />
                <SubHeading>Example</SubHeading>
                <CodeBlock>{`{
  "apiCalls": [
    {
      "file": "src/checkout.ts",
      "line": 47,
      "method": "GET",
      "url": "https://api.stripe.com/v1/customers/:id",
      "library": "axios",
      "frequency": "per-request"
    },
    {
      "file": "src/ai-assistant.ts",
      "line": 88,
      "method": "POST",
      "url": "https://api.openai.com/v1/chat/completions",
      "library": "fetch",
      "frequency": "1200/day"
    }
  ]
}`}</CodeBlock>
              </SectionCard>

              {/* ── 14. Rate Limits ─────────────────────────────────── */}
              <SectionCard id="limits" icon={AlertTriangle} badge="Limits" title="Rate Limits & Constraints" subtitle="Per project · Per request" delay={0.42}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                  {[
                    { stat: '2,000', label: 'max apiCalls / request', desc: 'Enforced in validation-service.ts. Returns 422 PAYLOAD_TOO_LARGE if exceeded.' },
                    { stat: '10 / 60s', label: 'scans per project', desc: 'KV-based counter per project. Returns 429 RATE_LIMIT_EXCEEDED if exceeded.' },
                  ].map(({ stat, label, desc }) => (
                    <div
                      key={stat}
                      style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '14px' }}
                    >
                      <p style={{ fontFamily: "'Playfair Display', serif", fontSize: '26px', fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>{stat}</p>
                      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0' }}>{label}</p>
                      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>{desc}</p>
                    </div>
                  ))}
                </div>
                <SubHeading>429 Response</SubHeading>
                <CodeBlock>{`HTTP/1.1 429 Too Many Requests

{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many scans. Retry after 60 seconds.",
    "status": 429
  }
}`}</CodeBlock>
              </SectionCard>

              {/* ── 15. Response Format ─────────────────────────────── */}
              <SectionCard id="response-format" icon={FileText} badge="Response Format" title="Response Shapes" subtitle='JSON · { data } wrapper · Consistent errors' delay={0.43}>
                <SubHeading>Single resource</SubHeading>
                <CodeBlock>{`{ "data": { "id": "...", ... } }`}</CodeBlock>
                <SubHeading>Paginated list</SubHeading>
                <CodeBlock>{`{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 47,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}`}</CodeBlock>
                <SubHeading>DELETE success</SubHeading>
                <CodeBlock>{`HTTP/1.1 204 No Content
(empty body)`}</CodeBlock>
                <SubHeading>Error</SubHeading>
                <CodeBlock>{`{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Project with id 'abc123' not found",
    "status": 404
  }
}`}</CodeBlock>
                <SubHeading>HTTP status codes</SubHeading>
                <DataTable
                  headers={['Code', 'Meaning']}
                  rows={[
                    ['200 OK',                    'Successful GET or PATCH'],
                    ['201 Created',               'Successful POST — resource created'],
                    ['204 No Content',            'Successful DELETE'],
                    ['400 Bad Request',           'Malformed JSON or missing/invalid Content-Type'],
                    ['404 Not Found',             'Resource does not exist'],
                    ['422 Unprocessable Entity',  'Field-level validation failure'],
                    ['429 Too Many Requests',     'Scan rate limit exceeded — retry after 60s'],
                    ['500 Internal Server Error', 'Unexpected worker error'],
                  ]}
                />
              </SectionCard>

              {/* ── 16. Example Workflow ────────────────────────────── */}
              <SectionCard id="workflow" icon={List} badge="Example Workflow" title="End-to-End curl Workflow" subtitle="Create → Scan → Endpoints → Suggestions → Cost → Sustainability" delay={0.44}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: '14px' }}>
                  Replace <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>{'{projectId}'}</code> with
                  the <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>id</code> returned by step 1.
                </p>
                <CodeBlock>{`# 1. Create project
curl -s -X POST https://your-worker.workers.dev/projects \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-app"}'
# → { "data": { "id": "a1b2c3d4-...", ... } }

# 2. Trigger scan
curl -s -X POST https://your-worker.workers.dev/projects/{projectId}/scans \\
  -H "Content-Type: application/json" \\
  -d '{
    "apiCalls": [{
      "file": "src/main.ts",
      "line": 21,
      "method": "GET",
      "url": "https://api.stripe.com/v1/customers",
      "library": "fetch",
      "frequency": "1200/day"
    }]
  }'

# 3. View detected endpoints
curl -s https://your-worker.workers.dev/projects/{projectId}/endpoints

# 4. View optimization suggestions
curl -s https://your-worker.workers.dev/projects/{projectId}/suggestions

# 5. View cost breakdown by provider
curl -s https://your-worker.workers.dev/projects/{projectId}/cost/by-provider

# 6. View sustainability stats
curl -s https://your-worker.workers.dev/projects/{projectId}/sustainability`}</CodeBlock>
              </SectionCard>

              {/* ── 17. Pricing Table ───────────────────────────────── */}
              <SectionCard id="pricing" icon={DollarSign} badge="Pricing" title="Provider Pricing" subtitle="api/src/config/pricing.ts — cost per API call" delay={0.45}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: '14px' }}>
                  EcoApi uses these per-call costs to estimate monthly spend. Provider detection is URL keyword matching.
                  Unrecognized URLs fall back to the internal rate.
                  Monthly cost = <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>calls_per_day × cost_per_call × 30</code>.
                </p>
                <DataTable
                  headers={['Provider', 'Cost / call (USD)', 'Detection keywords']}
                  rows={[
                    ['Stripe',            '$0.0100', 'stripe.com, api.stripe.com'],
                    ['OpenAI',            '$0.0060', 'openai.com, api.openai.com'],
                    ['Twilio',            '$0.0075', 'twilio.com, api.twilio.com'],
                    ['SendGrid',          '$0.0010', 'sendgrid.com, sendgrid'],
                    ['AWS S3',            '$0.0004', 's3.amazonaws.com, amazonaws.com'],
                    ['Google Maps',       '$0.0050', 'maps.googleapis.com'],
                    ['Internal/fallback', '$0.0001', '(any unrecognized URL)'],
                  ]}
                />
              </SectionCard>

              {/* ── 18. Frequency Heuristics ────────────────────────── */}
              <SectionCard id="frequency" icon={Cpu} badge="Frequency Heuristics" title="Frequency Heuristics" subtitle="frequency field → calls/day conversion" delay={0.46}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, marginBottom: '14px' }}>
                  When the <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>frequency</code> field is a keyword or
                  <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}> N/day</code> pattern, EcoApi converts it to a
                  daily call count used for cost and sustainability calculations.
                </p>
                <DataTable
                  headers={['Input value', 'Calls / day']}
                  rows={[
                    ['"per-request"',  '1,000'],
                    ['"per-session"',  '300'],
                    ['"hourly"',       '24'],
                    ['"daily"',        '1'],
                    ['"weekly"',       '~0.143 (1/7)'],
                    ['"1200/day"',     '1,200 (parsed N)'],
                    ['1200 (number)',  '1,200 (used directly)'],
                    ['unknown / omit', '100 (fallback)'],
                  ]}
                />
              </SectionCard>

              {/* CTA */}
              <Motion.div {...FADE(0.5)} className="text-center pt-4 pb-4">
                <button
                  onClick={() => navigate('/projects')}
                  className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full text-white text-[15px] transition-all hover:-translate-y-0.5"
                  style={{
                    background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})`,
                    fontFamily: "'Inter', sans-serif",
                    fontWeight: 500,
                  }}
                >
                  Dashboard
                  <ArrowRight size={16} />
                </button>
              </Motion.div>

            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
