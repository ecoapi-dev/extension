import React from 'react';
import { motion as Motion } from 'motion/react';
import { Link, useNavigate } from 'react-router';
import { useTheme } from '../theme-context';
import { Particles } from '../components/particles';
import {
  Leaf,
  ArrowLeft,
  Server,
  PuzzleIcon,
  LayoutDashboard,
  Code2,
  Zap,
  DollarSign,
  AlertTriangle,
  GitBranch,
  MessageSquare,
  Globe,
  ArrowRight,
} from 'lucide-react';

const FADE = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: 'easeOut' as const },
});

function Section({
  icon: Icon,
  badge,
  title,
  subtitle,
  description,
  features,
  delay,
}: {
  icon: React.ElementType;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  features: { icon: React.ElementType; label: string; desc: string }[];
  delay: number;
}) {
  const theme = useTheme();
  return (
    <Motion.div {...FADE(delay)} className="rounded-2xl border p-8 backdrop-blur-xl" style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderColor: 'rgba(255,255,255,0.07)' }}>
      {/* Badge */}
      <div className="flex items-center gap-2 mb-5">
        <div
          className="flex items-center gap-2 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest"
          style={{ background: `${theme.btnGradient[0]}22`, color: theme.btnGradient[0], border: `1px solid ${theme.btnGradient[0]}44`, fontFamily: "'JetBrains Mono', monospace" }}
        >
          <Icon size={12} />
          {badge}
        </div>
      </div>

      {/* Title */}
      <h2 className="text-[26px] text-white mb-1" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>
        {title}
      </h2>
      <p className="text-[13px] mb-4" style={{ color: theme.btnGradient[0], fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>
        {subtitle}
      </p>
      <p className="text-[14px] leading-relaxed mb-6" style={{ color: 'rgba(255,255,255,0.55)', fontFamily: "'Inter', sans-serif" }}>
        {description}
      </p>

      {/* Features grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {features.map(({ icon: FIcon, label, desc }) => (
          <div
            key={label}
            className="flex items-start gap-3 p-3.5 rounded-xl"
            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            <div
              className="mt-0.5 p-1.5 rounded-lg shrink-0"
              style={{ background: `${theme.btnGradient[0]}18` }}
            >
              <FIcon size={13} style={{ color: theme.btnGradient[0] }} />
            </div>
            <div>
              <p className="text-[12px] text-white mb-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
              <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.38)', fontFamily: "'Inter', sans-serif" }}>{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </Motion.div>
  );
}

export default function About() {
  const theme = useTheme();
  const navigate = useNavigate();

  return (
    <div className="relative w-full min-h-screen overflow-hidden" style={{ backgroundColor: theme.bg }}>
      {/* Background */}
      <div className="absolute inset-0 z-0" style={{ background: theme.skyGradient }} />
      <div className="absolute inset-0 z-[1] pointer-events-none" style={{ background: 'rgba(0,0,0,0.65)' }} />
      <Particles />

      {/* Content */}
      <div className="relative z-[10] min-h-screen flex flex-col">
        {/* Top nav */}
        <div className="flex items-center justify-between px-8 pt-8 pb-4">
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
        </div>

        {/* Hero text */}
        <Motion.div {...FADE(0)} className="text-center px-4 pt-10 pb-12">
          <h1
            className="text-[48px] md:text-[64px] text-white mb-4"
            style={{ fontFamily: "'Playfair Display', serif", fontWeight: 900, lineHeight: 1.05 }}
          >
            About EcoApi
          </h1>
          <p
            className="text-[16px] max-w-xl mx-auto"
            style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter', sans-serif", lineHeight: 1.7 }}
          >
            A full-stack platform to analyze your codebase's API usage, estimate costs, surface risks, and suggest optimizations — across three integrated surfaces.
          </p>
        </Motion.div>

        {/* Sections */}
        <div className="flex-1 px-4 pb-20 max-w-3xl mx-auto w-full space-y-6">
          <Section
            icon={Server}
            badge="REST API"
            title="EcoApi Backend"
            subtitle="Cloudflare Workers · Hono · D1 SQLite"
            description="The core engine. Send a list of API calls found in your codebase and EcoAPI analyses them — detecting redundant calls, N+1 patterns, cacheable endpoints, batch opportunities, and rate-limit risks. It calculates monthly cost estimates per provider, groups endpoints by file or provider, and generates actionable optimization suggestions with code fixes."
            features={[
              { icon: Code2, label: 'Scan endpoint', desc: 'POST raw API call data extracted from your source code' },
              { icon: DollarSign, label: 'Cost analytics', desc: 'Per-provider cost breakdown with monthly estimates' },
              { icon: AlertTriangle, label: 'Risk detection', desc: 'N+1, rate limit, redundancy, and cache opportunities' },
              { icon: GitBranch, label: 'Dependency graph', desc: 'File → endpoint relationships, cluster by provider or cost' },
            ]}
            delay={0.1}
          />

          <Section
            icon={PuzzleIcon}
            badge="IDE Extension"
            title="IDE Extension"
            subtitle="VS Code Extension Host · TypeScript · Webview UI"
            description="Install the EcoApi extension and scan your entire workspace without leaving your editor. Because EcoApi is built on the VS Code extension host, it runs natively in any compatible editor — VS Code, Cursor, Windsurf, and more. The extension scans TypeScript, JavaScript, Python, Go, and Ruby files, detects API calls using regex patterns across popular HTTP libraries (fetch, axios, requests, got), and sends them to the EcoAPI backend for analysis. Results appear in a sidebar panel with findings, suggestions, and an AI chat assistant."
            features={[
              { icon: Zap, label: 'One-click scan', desc: 'Scan your workspace instantly from the sidebar' },
              { icon: AlertTriangle, label: 'Inline findings', desc: 'Severity-grouped suggestions with code fix previews' },
              { icon: MessageSquare, label: 'AI chat', desc: 'Ask GPT-4o about any endpoint or suggestion' },
              { icon: Globe, label: 'Extension host compatible', desc: 'VS Code, Cursor, Windsurf — any host-compatible editor' },
            ]}
            delay={0.2}
          />

          <Section
            icon={LayoutDashboard}
            badge="Web Dashboard"
            title="EcoApi Dashboard"
            subtitle="React · TanStack Query · Tailwind CSS"
            description="This web app. Manage multiple projects, view full cost breakdowns, explore the API dependency graph, read optimization suggestions with estimated savings, and re-run scans with new API call data. Every page fetches live data from the EcoAPI backend"
            features={[
              { icon: LayoutDashboard, label: 'Project dashboard', desc: 'Eco Score gauge, stat cards, provider cost bars' },
              { icon: Server, label: 'Endpoints explorer', desc: 'Filter by provider, status, or HTTP method' },
              { icon: DollarSign, label: 'Savings summary', desc: 'Total estimated monthly savings across all suggestions' },
              { icon: GitBranch, label: 'Graph view', desc: 'Interactive file → endpoint dependency visualization' },
            ]}
            delay={0.3}
          />

          {/* CTA */}
          <Motion.div {...FADE(0.4)} className="text-center pt-4">
            <button
              onClick={() => navigate('/projects')}
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full text-white text-[15px] transition-all hover:-translate-y-0.5"
              style={{ background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})`, fontFamily: "'Inter', sans-serif", fontWeight: 500 }}
            >
              Dashboard
              <ArrowRight size={16} />
            </button>
          </Motion.div>
        </div>
      </div>
    </div>
  );
}
