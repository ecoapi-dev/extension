import { useState } from 'react';
import { motion as Motion, AnimatePresence } from 'motion/react';
import { Particles } from './particles';
import { AnimatedTree } from './animated-tree';
import { Navbar } from './navbar';
import { useTheme } from '../theme-context';
import { useNavigate } from 'react-router';
import { Sparkles, Sparkle } from 'lucide-react';

export function LandingPage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [showFireflies, setShowFireflies] = useState(true);

  return (
    <div className="relative w-full h-screen overflow-hidden transition-colors duration-1000" style={{ backgroundColor: theme.bg }}>
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
            {/* Primary: Get Started → /projects */}
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
                Get Started
              </span>
            </button>

            {/* Secondary: Learn More → /about */}
            <button
              onClick={() => navigate('/about')}
              className="px-8 py-3.5 rounded-full border transition-all duration-300 hover:-translate-y-0.5 cursor-pointer"
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: '0.9rem',
                fontWeight: 400,
                letterSpacing: '0.04em',
                color: theme.textTagline,
                borderColor: `${theme.textTagline}55`,
              }}
            >
              Learn More
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
  );
}
