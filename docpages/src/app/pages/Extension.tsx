import React, { useRef, useState, useEffect } from 'react';
import { motion as Motion } from 'motion/react';
import { Link } from 'react-router';
import { useTheme } from '../theme-context';
import { Particles } from '../components/particles';
import {
  Leaf,
  ArrowLeft,
  ChevronUp,
  PuzzleIcon,
  Download,
  Terminal,
  Settings,
  LayoutDashboard,
  Zap,
  MessageSquare,
  AlertTriangle,
  Globe,
  GitBranch,
  DollarSign,
  Search,
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

type Field = { name: string; type: string; default?: string; desc: string };

function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {['Setting', 'Type', 'Default', 'Description'].map((h) => (
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
              <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: 'rgba(255,255,255,0.45)' }}>{f.default ?? '—'}</td>
              <td style={{ padding: '7px 10px', fontFamily: "'Inter', sans-serif", fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── DataTable ───────────────────────────────────────────────────────────────

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

// ─── TOC ─────────────────────────────────────────────────────────────────────

const TOC_SECTIONS = [
  {
    label: 'Extension',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'installation', label: 'Installation' },
      { id: 'setup', label: 'Setup & Build' },
      { id: 'settings', label: 'Settings' },
    ],
  },
  {
    label: 'Dashboard',
    items: [
      { id: 'dashboard', label: 'Dashboard View' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { id: 'quick-start', label: 'Quick Start' },
    ],
  },
];

function TOCSidebar({ activeSection }: { activeSection: string }) {
  const theme = useTheme();
  return (
    <nav
      className="flex-1 flex flex-col min-h-0 overflow-y-auto scrollbar-hide"
      style={{ width: '100%', minWidth: '280px' }}
    >
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
            {section.items.map(({ id, label }) => {
              const isActive = activeSection === id;
              return (
                <a
                  key={id}
                  href={`#${id}`}
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: isActive ? '16px' : '15px',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.3)',
                    background: 'transparent',
                    textDecoration: 'none',
                    padding: '6px 10px 6px 16px',
                    borderRadius: '8px',
                    display: 'block',
                    transition: 'color 0.2s, background 0.2s, font-size 0.2s, font-weight 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLAnchorElement).style.color = theme.btnGradient[0];
                      (e.currentTarget as HTMLAnchorElement).style.background = `${theme.btnGradient[0]}10`;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.3)';
                      (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                    }
                  }}
                >
                  {label}
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Extension() {
  const theme = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<string>('');

  useEffect(() => {
    const ids = TOC_SECTIONS.flatMap(s => s.items.map(i => i.id));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        });
      },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    );
    ids.forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative w-full h-screen overflow-hidden flex flex-col" style={{ backgroundColor: theme.bg }}>
      {/* Background */}
      <div className="absolute inset-0 z-0" style={{ background: theme.skyGradient }} />
      <div className="absolute inset-0 z-[1] pointer-events-none" style={{ background: 'rgba(0,0,0,0.65)' }} />
      <Particles />

      {/* Top bar — sticky, never scrolls */}
      <header
        className="sticky top-0 z-20 flex-shrink-0 flex items-center justify-between px-8 py-3"
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
          style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none' }}
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

      {/* Body: sidebar + scrollable content */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar TOC */}
        <aside
          className="hidden md:flex flex-col flex-shrink-0 px-8 pt-14 pb-8 overflow-y-auto"
          style={{
            width: '260px',
            borderRight: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <TOCSidebar activeSection={activeSection} />
        </aside>

        {/* Main scrollable content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto scrollbar-hide px-6 md:px-10">
          <div className="space-y-5 pb-24">

            {/* Hero */}
            <Motion.div {...FADE(0)} className="px-4 pt-14 pb-6">
              <h1
                className="text-[40px] md:text-[52px] text-white mb-3"
                style={{ fontFamily: "'Playfair Display', serif", fontWeight: 900, lineHeight: 1.05 }}
              >
                Extension Docs
              </h1>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '16px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                VSCode extension that scans your workspace for API call patterns, estimates costs, and surfaces optimization opportunities — without leaving your editor.
              </p>
            </Motion.div>

            {/* Overview */}
            <SectionCard
              id="overview"
              icon={PuzzleIcon}
              badge="Extension"
              title="Overview"
              subtitle="VS Code Extension Host · TypeScript · Webview UI"
              delay={0.05}
            >
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '16px' }}>
                ECO is a VS Code extension that analyzes your entire codebase for API call patterns. Install it and scan your workspace in one click from the Activity Bar sidebar. Because it runs on the VS Code extension host, it works natively in any compatible editor — VS Code, Cursor, Windsurf, and more.
              </p>
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
              >
                {[
                  { icon: Search, label: 'Workspace scan', desc: 'Scans TS, JS, Python, Go, Java, and Ruby files for API calls' },
                  { icon: AlertTriangle, label: 'Risk detection', desc: 'Surfaces N+1, redundant calls, cacheable endpoints, and rate-limit risks' },
                  { icon: DollarSign, label: 'Cost estimation', desc: 'Monthly cost estimates per API provider' },
                  { icon: MessageSquare, label: 'AI chat', desc: 'Ask GPT-4o about any finding or suggestion directly in the sidebar' },
                  { icon: Globe, label: 'Editor compatible', desc: 'VS Code, Cursor, Windsurf — any extension-host-compatible editor' },
                  { icon: LayoutDashboard, label: 'Open Dashboard', desc: 'Launch a full local dashboard in the browser from the sidebar button' },
                ].map(({ icon: Icon, label, desc }) => (
                  <div
                    key={label}
                    className="flex items-start gap-3 p-3.5 rounded-xl"
                    style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div
                      className="mt-0.5 p-1.5 rounded-lg shrink-0"
                      style={{ background: `${theme.btnGradient[0]}18` }}
                    >
                      <Icon size={13} style={{ color: theme.btnGradient[0] }} />
                    </div>
                    <div>
                      <p className="text-[12px] text-white mb-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
                      <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.38)', fontFamily: "'Inter', sans-serif" }}>{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Installation */}
            <SectionCard
              id="installation"
              icon={Download}
              badge="Install"
              title="Installation"
              subtitle="From .vsix package or running in development"
              delay={0.1}
            >
              <SubHeading>From .vsix (production)</SubHeading>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '12px' }}>
                Open the Command Palette (<code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>Cmd+Shift+P</code> / <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>Ctrl+Shift+P</code>), run <strong style={{ color: 'rgba(255,255,255,0.75)' }}>Extensions: Install from VSIX...</strong>, and select the <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>eco-api-analyzer-*.vsix</code> file. Reload the window when prompted.
              </p>
              <SubHeading>Dev mode (F5)</SubHeading>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '12px' }}>
                Open the <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>extension/</code> folder in VS Code. Build the extension first (see Setup below), then press <strong style={{ color: 'rgba(255,255,255,0.75)' }}>F5</strong> to launch an Extension Development Host with the extension loaded.
              </p>
              <SubHeading>Package .vsix</SubHeading>
              <CodeBlock>{`cd extension
npx @vscode/vsce package --no-dependencies
# outputs eco-api-analyzer-*.vsix`}</CodeBlock>
            </SectionCard>

            {/* Setup & Build */}
            <SectionCard
              id="setup"
              icon={Terminal}
              badge="Build"
              title="Setup & Build"
              subtitle="Install dependencies and build all parts of the extension"
              delay={0.15}
            >
              <SubHeading>Install dependencies</SubHeading>
              <CodeBlock>{`cd extension && npm install
cd webview  && npm install && cd ..
cd ../dashboard && npm install`}</CodeBlock>

              <SubHeading>Build commands (run from extension/)</SubHeading>
              <DataTable
                headers={['Command', 'Description']}
                rows={[
                  ['npm run build', 'Full build: dashboard + webview + extension backend'],
                  ['npm run build:ext', 'Extension backend only (esbuild)'],
                  ['npm run build:webview', 'Sidebar webview UI only (Vite)'],
                  ['npm run build:dashboard', 'Dashboard app with VITE_LOCAL_MODE=true'],
                  ['npm run watch:ext', 'Watch mode for extension backend'],
                  ['npm run watch:webview', 'Watch mode for sidebar webview'],
                ]}
              />

              <SubHeading>Full build</SubHeading>
              <CodeBlock>{`cd extension
npm run build`}</CodeBlock>

              <SubHeading>Dev workflow (watch mode)</SubHeading>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '10px' }}>
                Run these in parallel in two terminals, then press F5 to launch the Extension Development Host:
              </p>
              <CodeBlock>{`# Terminal 1 — extension backend
cd extension && npm run watch:ext

# Terminal 2 — sidebar webview
cd extension && npm run watch:webview`}</CodeBlock>
            </SectionCard>

            {/* Settings */}
            <SectionCard
              id="settings"
              icon={Settings}
              badge="Config"
              title="Extension Settings"
              subtitle="Configure via VS Code Settings (Cmd+, / Ctrl+,) under ECO API Analyzer"
              delay={0.2}
            >
              <FieldTable
                fields={[
                  {
                    name: 'eco.scanGlob',
                    type: 'string',
                    default: '**/*.{ts,tsx,js,jsx,py,go,java,rb}',
                    desc: 'Glob pattern for files to include in the workspace scan',
                  },
                  {
                    name: 'eco.excludeGlob',
                    type: 'string',
                    default: '**/node_modules/**,**/dist/**,...',
                    desc: 'Comma-separated glob patterns for files and directories to exclude',
                  },
                  {
                    name: 'eco.aiReview.enabled',
                    type: 'boolean',
                    default: 'true',
                    desc: 'Enable the AI second-pass review of scan results',
                  },
                  {
                    name: 'eco.aiReview.minConfidence',
                    type: 'number',
                    default: '0.7',
                    desc: 'Minimum confidence threshold (0–1) for AI findings to be accepted',
                  },
                  {
                    name: 'eco.aiReview.maxFiles',
                    type: 'number',
                    default: '25',
                    desc: 'Maximum number of files to include in the AI review context (1–100)',
                  },
                  {
                    name: 'eco.aiReview.maxCharsPerFile',
                    type: 'number',
                    default: '6000',
                    desc: 'Maximum characters per file excerpt sent to AI review (500–20000)',
                  },
                  {
                    name: 'eco.aiReview.model',
                    type: 'string',
                    default: 'gpt-4.1-mini',
                    desc: 'OpenAI model used for AI review (e.g. gpt-4.1-mini, gpt-4o)',
                  },
                ]}
              />
            </SectionCard>

            {/* Dashboard */}
            <SectionCard
              id="dashboard"
              icon={LayoutDashboard}
              badge="Dashboard"
              title="Dashboard View"
              subtitle="Full local dashboard launched from the sidebar — no remote API required"
              delay={0.25}
            >
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '16px' }}>
                After scanning your workspace, click <strong style={{ color: 'rgba(255,255,255,0.75)' }}>Open Dashboard</strong> in the sidebar panel. This launches a full React dashboard in your browser backed entirely by local scan data — the same data collected by the extension scan, with no remote API calls.
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '16px' }}>
                The dashboard is built with <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>VITE_LOCAL_MODE=true</code>, so navigating to <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>/</code> automatically redirects to <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>/projects/local</code> — the local project view.
              </p>
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5"
              >
                {[
                  { icon: LayoutDashboard, label: 'Project overview', desc: 'Eco Score gauge, stat cards, provider cost breakdown' },
                  { icon: Globe, label: 'Endpoints explorer', desc: 'Filter by provider, HTTP method, or status' },
                  { icon: AlertTriangle, label: 'Suggestions', desc: 'Severity-grouped optimizations with code fix previews and savings estimates' },
                  { icon: GitBranch, label: 'Dependency graph', desc: 'Interactive file → endpoint visualization with clustering' },
                  { icon: DollarSign, label: 'Cost analytics', desc: 'Monthly cost estimates and potential savings totals' },
                  { icon: MessageSquare, label: 'AI chat', desc: 'In-dashboard AI assistant with context from your scan results' },
                ].map(({ icon: Icon, label, desc }) => (
                  <div
                    key={label}
                    className="flex items-start gap-3 p-3.5 rounded-xl"
                    style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div
                      className="mt-0.5 p-1.5 rounded-lg shrink-0"
                      style={{ background: `${theme.btnGradient[0]}18` }}
                    >
                      <Icon size={13} style={{ color: theme.btnGradient[0] }} />
                    </div>
                    <div>
                      <p className="text-[12px] text-white mb-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
                      <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.38)', fontFamily: "'Inter', sans-serif" }}>{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <SubHeading>Build the dashboard</SubHeading>
              <CodeBlock>{`# from extension/
npm run build:dashboard`}</CodeBlock>
            </SectionCard>

            {/* Quick Start */}
            <SectionCard
              id="quick-start"
              icon={Zap}
              badge="Quick Start"
              title="Quick Start"
              subtitle="Get up and running in minutes"
              delay={0.3}
            >
              <SubHeading>Option 1 — automated script</SubHeading>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, marginBottom: '10px' }}>
                Run <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>start-extension-full.sh</code> from the project root. It installs all dependencies (including the dashboard), builds everything, and opens the extension folder in your editor.
              </p>
              <CodeBlock>{`bash start-extension-full.sh`}</CodeBlock>

              <SubHeading>Option 2 — manual steps</SubHeading>
              <CodeBlock>{`# 1. Install dependencies
cd extension && npm install
cd webview  && npm install && cd ..
cd ../dashboard && npm install && cd ../extension

# 2. Build the extension
npm run build

# 3. Open extension/ in VS Code and press F5
#    → Extension Development Host launches with ECO loaded`}</CodeBlock>

              <SubHeading>After launch</SubHeading>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.7 }}>
                Click the leaf icon in the Activity Bar to open the ECO sidebar. Press the scan button (or run <strong style={{ color: 'rgba(255,255,255,0.75)' }}>ECO: Scan Workspace</strong> from the Command Palette) to analyze your codebase. Results appear immediately in the sidebar, and you can click <strong style={{ color: 'rgba(255,255,255,0.75)' }}>Open Dashboard</strong> to view the full dashboard in your browser.
              </p>
            </SectionCard>

          </div>
        </main>
      </div>

      {/* Back to top */}
      <button
        onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '40px',
          height: '40px',
          borderRadius: '9999px',
          backgroundColor: 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.25)',
          color: 'rgba(255,255,255,0.8)',
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >
        <ChevronUp size={18} />
      </button>
    </div>
  );
}
