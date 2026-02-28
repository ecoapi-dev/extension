import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { motion as Motion } from 'motion/react';
import { Plus, Server, ArrowRight, Loader2, FolderOpen, Leaf, ArrowLeft } from 'lucide-react';
import { useTheme } from '../theme-context';
import { Particles } from '../components/particles';
import { AnimatedTree } from '../components/animated-tree';
import { useProjects, useCreateProject } from '@/lib/queries';
import type { ProjectInput } from '@/lib/types';

export default function Projects() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, error } = useProjects({ limit: 100 });
  const projects = data?.data ?? [];

  return (
    <div className="relative w-full min-h-screen overflow-hidden" style={{ backgroundColor: theme.bg }}>
      {/* Background layers */}
      <div className="absolute inset-0 z-0" style={{ background: theme.skyGradient }} />
      <div
        className="absolute bottom-[22%] left-1/2 -translate-x-1/2 w-[140%] h-[30%] opacity-10 z-[1]"
        style={{ background: `radial-gradient(ellipse 60% 50% at 50% 80%, ${theme.horizonGlow} 0%, transparent 70%)` }}
      />
      <div className="absolute inset-0 z-[2] pointer-events-none" style={{ background: 'rgba(0,0,0,0.55)' }} />
      <Particles />
      <AnimatedTree />

      {/* Dark overlay */}
      <div className="absolute inset-0 z-[6] pointer-events-none" style={{ background: 'rgba(0,0,0,0.4)' }} />

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

        {/* Main content */}
        <div className="flex-1 flex flex-col items-center justify-start px-4 py-8">
          <Motion.div
            className="w-full max-w-2xl"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-end justify-between mb-6">
              <div>
                <h1
                  className="text-[28px] text-white"
                  style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}
                >
                  Your Projects
                </h1>
                <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,0.45)', fontFamily: "'Inter', sans-serif" }}>
                  Select a project to open its dashboard
                </p>
              </div>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] text-white transition-all hover:-translate-y-0.5"
                style={{
                  background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})`,
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 500,
                }}
              >
                <Plus size={15} />
                New Project
              </button>
            </div>

            {/* Card container */}
            <div
              className="rounded-2xl border backdrop-blur-2xl p-6"
              style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderColor: 'rgba(255,255,255,0.07)' }}
            >
              {isLoading && (
                <div className="flex items-center justify-center py-20">
                  <Loader2 size={22} className="animate-spin" style={{ color: theme.btnGradient[0] }} />
                </div>
              )}

              {error && (
                <div className="text-center py-20">
                  <p className="text-red-400 text-[13px]">Failed to load projects. Is the API running?</p>
                  <p className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,0.35)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {import.meta.env.VITE_API_URL || 'http://localhost:8787'}
                  </p>
                </div>
              )}

              {!isLoading && !error && projects.length === 0 && (
                <div className="text-center py-20">
                  <FolderOpen size={36} className="mx-auto mb-3" style={{ color: 'rgba(255,255,255,0.15)' }} />
                  <p className="text-[13px]" style={{ color: 'rgba(255,255,255,0.4)', fontFamily: "'Inter', sans-serif" }}>
                    No projects yet.
                  </p>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="mt-4 px-5 py-2 rounded-full text-[13px] text-white transition-all hover:-translate-y-0.5"
                    style={{ background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})` }}
                  >
                    Create your first project
                  </button>
                </div>
              )}

              {!isLoading && !error && projects.length > 0 && (
                <div className="space-y-2">
                  {projects.map((project, i) => (
                    <Motion.button
                      key={project.id}
                      onClick={() => navigate(`/projects/${project.id}`)}
                      className="w-full text-left p-5 rounded-xl border transition-all duration-200 group"
                      style={{
                        backgroundColor: 'rgba(255,255,255,0.03)',
                        borderColor: 'rgba(255,255,255,0.06)',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: i * 0.05 }}
                      whileHover={{ y: -2 }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <h3
                            className="text-[15px] text-white transition-colors group-hover:text-[#4EAA57]"
                            style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500 }}
                          >
                            {project.name}
                          </h3>
                          {project.description && (
                            <p className="text-[12px] mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.38)' }}>
                              {project.description}
                            </p>
                          )}
                          <div className="flex items-center gap-4 mt-2.5 text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                            <span className="flex items-center gap-1">
                              <Server size={10} />
                              {project.latestScanId ? 'Scanned' : 'No scans'}
                            </span>
                            <span>Created {new Date(project.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <ArrowRight
                          size={15}
                          className="opacity-0 group-hover:opacity-100 transition-all group-hover:translate-x-1"
                          style={{ color: theme.btnGradient[0] }}
                        />
                      </div>
                    </Motion.button>
                  ))}
                </div>
              )}
            </div>
          </Motion.div>
        </div>
      </div>

      {showCreate && (
        <CreateProjectDialog
          theme={theme}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/projects/${id}`)}
        />
      )}
    </div>
  );
}

function CreateProjectDialog({
  theme,
  onClose,
  onCreated,
}: {
  theme: ReturnType<typeof useTheme>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [apiCallsJson, setApiCallsJson] = useState('');
  const createProject = useCreateProject();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input: ProjectInput = { name, description: description || undefined };
    if (apiCallsJson.trim()) {
      try {
        input.apiCalls = JSON.parse(apiCallsJson);
      } catch {
        return;
      }
    }
    const result = await createProject.mutateAsync(input);
    onCreated(result.data.id);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <Motion.div
        className="relative w-full max-w-md rounded-2xl border p-6"
        style={{ backgroundColor: '#0B0F0B', borderColor: '#243224', fontFamily: "'JetBrains Mono', monospace" }}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
      >
        <h2 className="text-[16px] text-[#D6EDD0] mb-4">Create Project</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-[#7EA87E] mb-1.5 uppercase tracking-wider">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="my-api-project"
              className="w-full bg-[#131A13] border border-[#243224] rounded-lg px-3 py-2 text-[13px] text-[#D6EDD0] placeholder:text-[#7EA87E]/40 focus:outline-none focus:border-[#4EAA57]/40"
            />
          </div>
          <div>
            <label className="block text-[11px] text-[#7EA87E] mb-1.5 uppercase tracking-wider">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full bg-[#131A13] border border-[#243224] rounded-lg px-3 py-2 text-[13px] text-[#D6EDD0] placeholder:text-[#7EA87E]/40 focus:outline-none focus:border-[#4EAA57]/40"
            />
          </div>
          <div>
            <label className="block text-[11px] text-[#7EA87E] mb-1.5 uppercase tracking-wider">API Calls JSON (optional)</label>
            <textarea
              value={apiCallsJson}
              onChange={(e) => setApiCallsJson(e.target.value)}
              placeholder='[{"file":"src/api.ts","line":10,"method":"GET","url":"https://api.stripe.com/v1/charges","library":"fetch"}]'
              rows={4}
              className="w-full bg-[#131A13] border border-[#243224] rounded-lg px-3 py-2 text-[11px] text-[#D6EDD0] placeholder:text-[#7EA87E]/30 focus:outline-none focus:border-[#4EAA57]/40 font-mono resize-none"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[12px] border border-[#243224] text-[#7EA87E] hover:text-[#D6EDD0] hover:border-[#4EAA57]/30 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createProject.isPending}
              className="flex-1 py-2 rounded-lg text-[12px] text-white transition-all disabled:opacity-40"
              style={{ background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})` }}
            >
              {createProject.isPending ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Create'}
            </button>
          </div>
        </form>
      </Motion.div>
    </div>
  );
}
