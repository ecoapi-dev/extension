import { Link, Outlet, useLocation, useParams } from 'react-router';
import { LayoutDashboard, Radio, Lightbulb, Share2, MessageSquare, Settings, Leaf, ArrowLeft } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { useProject } from '@/lib/queries';
import { ThemeProvider } from '../theme-context';
import { galaxySunsetTheme } from '../themes';
import { Particles } from '../components/particles';
import { AnimatedTree } from '../components/animated-tree';

export function Layout() {
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projectData } = useProject(projectId);
  const project = projectData?.data;

  const base = `/projects/${projectId}`;

  const navItems = [
    { icon: LayoutDashboard, path: base, label: 'Dashboard' },
    { icon: Radio, path: `${base}/endpoints`, label: 'Endpoints' },
    { icon: Lightbulb, path: `${base}/suggestions`, label: 'Suggestions' },
    { icon: Share2, path: `${base}/graph`, label: 'Graph' },
    { icon: MessageSquare, path: `${base}/chat`, label: 'AI Chat' },
  ];

  const checkActive = (path: string) => {
    if (path === base) return location.pathname === base || location.pathname === `${base}/`;
    return location.pathname.startsWith(path);
  };

  const minimalBgPaths = ['', '/endpoints', '/chat', '/suggestions'];
  const pathSuffix = projectId ? (location.pathname.replace(new RegExp(`^/projects/${projectId}`), '') || '').replace(/\/$/, '') || '' : '';
  const useMinimalBg = minimalBgPaths.includes(pathSuffix);

  return (
    <ThemeProvider theme={galaxySunsetTheme}>
      <div
        className="relative h-screen w-full overflow-hidden text-[#D6EDD0] selection:bg-[#4EAA57]/30 selection:text-white"
        style={{ backgroundColor: galaxySunsetTheme.bg, fontFamily: "'JetBrains Mono', monospace" }}
      >
        {/* Background atmosphere */}
        <div className="absolute inset-0 z-0" style={{ background: galaxySunsetTheme.skyGradient }} />
        <div className="absolute inset-0 z-[1] pointer-events-none" style={{ background: 'rgba(0,0,0,0.6)' }} />
        {!useMinimalBg && <Particles />}
        {!useMinimalBg && <AnimatedTree />}
        <div className="absolute inset-0 z-[6] pointer-events-none" style={{ background: 'rgba(0,0,0,0.4)' }} />

        {/* App shell */}
        <div className="relative z-[10] flex h-full">
          {/* Nav Rail */}
          <nav className="w-14 shrink-0 flex flex-col items-center py-3 border-r border-white/[0.07] bg-black/50 backdrop-blur-xl z-10">
            <Link
              to="/"
              className="mb-2 flex items-center justify-center w-10 h-10 rounded-lg transition-colors group relative"
              style={{ color: 'rgba(255,255,255,0.4)' }}
              title="Back to Projects"
            >
              <ArrowLeft size={16} strokeWidth={1.5} />
              <div className="absolute left-12 bg-black/70 backdrop-blur-sm text-white text-[11px] px-2 py-1 rounded border border-white/[0.1] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                All Projects
              </div>
            </Link>

            <div className="mb-4 flex items-center justify-center w-10 h-10">
              <Leaf size={22} className="text-[#4EAA57]" strokeWidth={2.5} />
            </div>

            <div className="flex-1 flex flex-col gap-1 w-full px-2">
              {navItems.map((item) => {
                const isActive = checkActive(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={twMerge(
                      "flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-200 group relative",
                      isActive
                        ? "bg-white/[0.1] text-[#4EAA57]"
                        : "hover:bg-white/[0.06]"
                    )}
                    style={{ color: isActive ? '#4EAA57' : 'rgba(255,255,255,0.4)' }}
                    title={item.label}
                  >
                    <item.icon size={18} strokeWidth={isActive ? 2 : 1.5} />
                    {isActive && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#4EAA57] rounded-r-full -ml-2" />
                    )}
                    <div className="absolute left-12 bg-black/70 backdrop-blur-sm text-white text-[11px] px-2 py-1 rounded border border-white/[0.1] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                      {item.label}
                    </div>
                  </Link>
                );
              })}
            </div>

            <button
              className="flex items-center justify-center w-10 h-10 rounded-lg transition-colors mt-auto group relative"
              style={{ color: 'rgba(255,255,255,0.4)' }}
            >
              <Settings size={18} strokeWidth={1.5} />
              <div className="absolute left-12 bg-black/70 backdrop-blur-sm text-white text-[11px] px-2 py-1 rounded border border-white/[0.1] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                Settings
              </div>
            </button>
          </nav>

          {/* Main Content */}
          <main className="flex-1 overflow-hidden relative flex flex-col">
            {project && (
              <div className="sticky top-0 z-10 bg-black/40 backdrop-blur-md border-b border-white/[0.06] px-6 py-2">
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>{project.name}</span>
              </div>
            )}
            <div className="flex-1 min-h-0">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
}
