import { useState } from 'react';
import { motion as Motion, AnimatePresence } from 'motion/react';
import { Particles } from './particles';
import { AnimatedTree } from './animated-tree';
import { Navbar } from './navbar';
import { useTheme } from '../theme-context';
import { useNavigate } from 'react-router';
import { Sparkles, Sparkle, ChevronDown, ArrowRight } from 'lucide-react';

const FADE = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: 'easeOut' as const },
});

export function LandingPage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [showFireflies, setShowFireflies] = useState(true);

  return (
    <div className="relative w-full transition-colors duration-1000" style={{ backgroundColor: theme.bg }}>
      {/* ===== HERO SECTION ===== */}
      <div className="relative h-screen overflow-hidden">
        {/* === SKY GRADIENT === */}
        <div
          className="absolute inset-0 z-0 transition-all duration-1000"
          style={{ background: theme.skyGradient }}
        />

        {/* Warm horizon glow */}
        <div
          className="absolute bottom-[22%] left-1/2 -translate-x-1/2 w-[140%] h-[30%] opacity-20 z-[1] transition-all duration-1000"
          style={{
            background: `radial-gradient(ellipse 60% 50% at 50% 80%, ${theme.horizonGlow} 0%, transparent 70%)`,
          }}
        />

        {/* Mist layers */}
        <Motion.div
          className="absolute bottom-[20%] left-[-10%] w-[120%] h-[30%] opacity-[0.04] z-[1]"
          style={{
            background: `radial-gradient(ellipse at center, ${theme.mistColor}, transparent 70%)`,
          }}
          animate={{ x: [-20, 20, -20], opacity: [0.03, 0.05, 0.03] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
        />
        <Motion.div
          className="absolute bottom-[25%] left-[-20%] w-[140%] h-[20%] opacity-[0.03] z-[5] pointer-events-none"
          style={{
            background: `linear-gradient(90deg, transparent, ${theme.mistColor}, transparent)`,
          }}
          animate={{ x: [40, -40, 40] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Floating particles */}
        <AnimatePresence>
          {showFireflies && (
            <Motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1 }}
            >
              <Particles />
            </Motion.div>
          )}
        </AnimatePresence>

        {/* === SVG TREE + STATIC GROUND === */}
        <AnimatedTree />

        {/* Navbar */}
        <Navbar />

        {/* Dark overlay for text readability */}
        <div
          className="absolute inset-0 z-[6] pointer-events-none transition-opacity duration-1000"
          style={{
            backgroundImage: `linear-gradient(to bottom, ${theme.bg}AA 0%, transparent 100%)`,
            opacity: theme.id === 'purple' ? 1 : 0.4,
          }}
        />

        {/* === HERO CONTENT === */}
        <div className="relative z-[10] flex flex-col items-center justify-center h-full px-4 pb-[18vh]">
          <div className="flex flex-col items-center text-center">
            {/* Title */}
            <Motion.h1
              className="inline-block"
              style={{
                fontFamily: "'Playfair Display', serif",
                fontSize: 'clamp(3.5rem, 12vw, 10rem)',
                fontWeight: 900,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                color: '#ffffff',
                filter: `drop-shadow(0 4px 12px ${theme.textTitleGrad[0]}44)`,
              }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
            >
              EcoApi
            </Motion.h1>

            {/* Tagline */}
            <Motion.p
              className="mt-4 md:mt-6 tracking-[0.25em] uppercase drop-shadow-[0_2px_15px_rgba(0,0,0,0.3)]"
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 'clamp(0.7rem, 1.5vw, 0.9rem)',
                fontWeight: 500,
                fontStyle: 'italic',
                color: theme.textTagline,
              }}
              initial={{ opacity: 0, letterSpacing: '0.1em' }}
              animate={{ opacity: 1, letterSpacing: '0.25em' }}
              transition={{ duration: 1.5, delay: 0.8, ease: 'easeOut' }}
            >
              Clean Code &bull; Low Costs
            </Motion.p>

            {/* CTA Buttons */}
            <Motion.div
              className="flex flex-col sm:flex-row items-center gap-4 mt-10 md:mt-14"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 1, ease: 'easeOut' }}
            >
              {/* Primary: Dashboard → /projects */}
              <button
                onClick={() => navigate('/projects')}
                className="relative group px-8 py-3.5 rounded-full overflow-hidden transition-all duration-300 hover:-translate-y-0.5 cursor-pointer"
                style={{ fontFamily: "'Inter', sans-serif" }}
              >
                <div
                  className="absolute inset-0 opacity-90 group-hover:opacity-100 transition-opacity"
                  style={{ background: `linear-gradient(to right, ${theme.btnGradient[0]}, ${theme.btnGradient[1]})` }}
                />
                <div
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                  style={{ boxShadow: `0 0 30px ${theme.btnShadow}` }}
                />
                <span className="relative z-10 text-white tracking-wider" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                  Dashboard
                </span>
              </button>

              {/* Secondary: Docs → /docs */}
              <button
                onClick={() => navigate('/docs')}
                className="px-8 py-3.5 rounded-full border transition-all duration-300 hover:-translate-y-0.5 cursor-pointer"
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.9rem',
                  fontWeight: 500,
                  letterSpacing: '0.04em',
                  color: '#ffffff',
                  backgroundColor: 'rgba(255,255,255,0.12)',
                  borderColor: 'rgba(255,255,255,0.3)',
                }}
              >
                Docs
              </button>
            </Motion.div>
          </div>
        </div>

        {/* Bottom vignette */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[25%] z-[4] pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(to top, ${theme.bg} 0%, transparent 100%)`,
          }}
        />

        {/* Scroll down indicator */}
        <Motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[10] flex flex-col items-center gap-1 pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.45 }}
          transition={{ duration: 1, delay: 1.8 }}
        >
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: 'rgba(255,255,255,0.5)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>scroll</span>
          <Motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <ChevronDown size={18} color="rgba(255,255,255,0.5)" />
          </Motion.div>
        </Motion.div>

        {/* UI Controls (Particle Toggle) */}
        <div className="fixed bottom-6 left-6 z-[100]">
          <button
            onClick={() => setShowFireflies(!showFireflies)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-medium transition-all border"
            style={{
              backgroundColor: showFireflies ? 'rgba(255,255,255,0.1)' : 'transparent',
              borderColor: showFireflies ? '#ffffff44' : '#ffffff22',
              color: showFireflies ? '#ffffff' : '#ffffff66',
            }}
          >
            {showFireflies ? <Sparkles size={12} /> : <Sparkle size={12} />}
            <span>Fireflies: {showFireflies ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      {/* ===== SUSTAINABILITY SECTION ===== */}
      <div className="relative h-screen flex flex-col justify-center" style={{ backgroundColor: '#000000' }}>
        {/* Top fade from hero bg to black */}
        <div
          className="absolute top-0 left-0 right-0 h-32 pointer-events-none z-0"
          style={{ background: `linear-gradient(to bottom, ${theme.bg}, #000000)` }}
        />

        <div className="relative z-[1] max-w-5xl mx-auto px-8 w-full">
          {/* Section header */}
          <Motion.div {...FADE(0)} className="text-center mb-8">
            <h2
              className="text-[56px] md:text-[80px] text-white mb-3"
              style={{ fontFamily: "'Playfair Display', serif", fontWeight: 900, lineHeight: 1.05 }}
            >
              Our Mission
            </h2>
            <p
              className="text-[14px] max-w-lg mx-auto"
              style={{ color: 'rgba(255,255,255,0.45)', fontFamily: "'Inter', sans-serif", lineHeight: 1.7 }}
            >
              Software efficiency is an environmental issue. EcoApi exists to make every unnecessary API call visible and every optimization count.
            </p>
          </Motion.div>

          {/* Stat + lightbulb */}
          <Motion.div {...FADE(0.1)} className="flex items-center justify-center gap-5 mb-10">
            <p style={{ fontFamily: "'Playfair Display', serif", fontSize: '30px', fontWeight: 500, fontStyle: 'italic', color: '#ffffff', lineHeight: 1.35, maxWidth: '420px', textAlign: 'center', textShadow: '0 0 25px rgba(255,215,0,0.35), 0 0 60px rgba(255,215,0,0.15)' }}>
              1M unnecessary API calls ≈ 10 kWh wasted. EcoApi makes them visible.
            </p>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="pulse-glow-icon w-24 h-24 shrink-0" style={{ overflow: 'visible' }}>
              <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>
            </svg>
          </Motion.div>

          {/* 3-column mission cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Card 1 */}
            <Motion.div {...FADE(0.2)} className="rounded-2xl border p-6 backdrop-blur-xl" style={{ backgroundColor: 'rgba(0,0,0,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}>
              <h3 className="text-[18px] text-white mb-3" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>
                Sustainable by Design
              </h3>
              <p className="text-[13px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter', sans-serif" }}>
                EcoApi surfaces redundant calls, N+1 patterns, and cacheable endpoints so your code ships leaner and consumes less energy.
              </p>
            </Motion.div>

            {/* Card 2 */}
            <Motion.div {...FADE(0.3)} className="rounded-2xl border p-6 backdrop-blur-xl" style={{ backgroundColor: 'rgba(0,0,0,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}>
              <h3 className="text-[18px] text-white mb-3" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>
                Environmental Impact
              </h3>
              <p className="text-[13px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter', sans-serif" }}>
                AI-powered scanning will estimate electricity (kWh) and water (L) consumed per scan, not just dollars saved.
              </p>
            </Motion.div>

            {/* Card 3 */}
            <Motion.div {...FADE(0.4)} className="rounded-2xl border p-6 backdrop-blur-xl" style={{ backgroundColor: 'rgba(0,0,0,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}>
              <h3 className="text-[18px] text-white mb-3" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>
                Why It Matters
              </h3>
              <p className="text-[13px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter', sans-serif" }}>
                Small inefficiencies at scale add up to tons of CO₂. EcoApi makes every optimization visible, measurable, and actionable.
              </p>
            </Motion.div>
          </div>

          {/* CTA */}
          <Motion.div {...FADE(0.5)} className="flex flex-col items-center mt-10">
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
