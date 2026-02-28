import { Link, Outlet, useLocation, useParams } from 'react-router';
import { LayoutDashboard, Radio, Lightbulb, Share2, MessageSquare, Settings, Leaf, ArrowLeft } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { useProject } from '@/lib/queries';

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

  return (
    <div className="flex h-screen w-full bg-[#0B0F0B] text-[#D6EDD0] overflow-hidden selection:bg-[#4EAA57]/30 selection:text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Nav Rail */}
      <nav className="w-14 shrink-0 flex flex-col items-center py-3 border-r border-[#243224] bg-[#0B0F0B] z-10">
        {/* Back to projects */}
        <Link
          to="/"
          className="mb-2 flex items-center justify-center w-10 h-10 rounded-lg text-[#7EA87E] hover:text-[#D6EDD0] hover:bg-[#131A13] transition-colors group relative"
          title="Back to Projects"
        >
          <ArrowLeft size={16} strokeWidth={1.5} />
          <div className="absolute left-12 bg-[#1C271C] text-[#D6EDD0] text-[11px] px-2 py-1 rounded border border-[#243224] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
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
                    ? "bg-[#1C271C] text-[#4EAA57]"
                    : "text-[#7EA87E] hover:text-[#D6EDD0] hover:bg-[#131A13]"
                )}
                title={item.label}
              >
                <item.icon size={18} strokeWidth={isActive ? 2 : 1.5} />
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#4EAA57] rounded-r-full -ml-2" />
                )}
                <div className="absolute left-12 bg-[#1C271C] text-[#D6EDD0] text-[11px] px-2 py-1 rounded border border-[#243224] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                  {item.label}
                </div>
              </Link>
            );
          })}
        </div>

        <button className="flex items-center justify-center w-10 h-10 rounded-lg text-[#7EA87E] hover:text-[#D6EDD0] hover:bg-[#131A13] transition-colors mt-auto group relative">
          <Settings size={18} strokeWidth={1.5} />
          <div className="absolute left-12 bg-[#1C271C] text-[#D6EDD0] text-[11px] px-2 py-1 rounded border border-[#243224] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
            Settings
          </div>
        </button>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-[#0B0F0B] relative">
        {project && (
          <div className="sticky top-0 z-10 bg-[#0B0F0B]/90 backdrop-blur-sm border-b border-[#243224]/50 px-6 py-2">
            <span className="text-[11px] text-[#7EA87E]">{project.name}</span>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
