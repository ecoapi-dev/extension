export interface ThemeColors {
  id: string;
  name: string;
  bg: string;
  skyGradient: string;
  horizonGlow: string;
  mistColor: string;
  groundColor1: string;
  groundColor2: string;
  treeBarkGrad: [string, string, string];
  foliageColor: string;
  particleColors: [string, string];
  btnGradient: [string, string];
  btnShadow: string;
  textTitleGrad: [string, string];
  textTagline: string;
}

const GREEN_FOLIAGE = '#2e7d32';

const GALAXY_BG = '#020617';
const GALAXY_SKY = 'linear-gradient(180deg, #0a0a20 0%, #050512 40%, #020617 100%)';
const GALAXY_MIST = 'rgba(10, 10, 32, 0.4)';

export const purpleTheme: ThemeColors = {
  id: 'purple',
  name: 'Midnight Lavender',
  bg: '#0d0d1a',
  skyGradient: 'linear-gradient(180deg, #c4a8c8 0%, #b098b8 10%, #9688ab 20%, #7e6f96 32%, #685c82 44%, #524068 56%, #3e2f58 68%, #2a1f42 80%, #170f2c 92%, #0d0d1a 100%)',
  horizonGlow: '#c4978a',
  mistColor: 'rgba(180,170,240,0.8)',
  groundColor1: '#0a0a1a',
  groundColor2: '#060614',
  treeBarkGrad: ['#252545', '#1a1a2e', '#0a0a1a'],
  foliageColor: '#059669',
  particleColors: ['rgba(230, 220, 255, 1)', 'rgba(180, 160, 240, 1)'],
  btnGradient: ['#8b7ea6', '#6d5580'],
  btnShadow: 'rgba(139, 126, 166, 0.5)',
  textTitleGrad: ['#fff', 'rgba(200,190,220,0.8)'],
  textTagline: 'rgba(200,190,220,0.6)',
};

export const galaxySunsetTheme: ThemeColors = {
  id: 'galaxy-sunset',
  name: 'Galaxy Sunset',
  bg: GALAXY_BG,
  skyGradient: GALAXY_SKY,
  horizonGlow: '#064e3b',
  mistColor: GALAXY_MIST,
  groundColor1: '#020617',
  groundColor2: '#000000',
  treeBarkGrad: ['#451a03', '#78350f', '#451a03'],
  foliageColor: GREEN_FOLIAGE,
  particleColors: ['rgba(34, 197, 94, 1)', 'rgba(74, 222, 128, 0.8)'],
  btnGradient: ['#16a34a', '#15803d'],
  btnShadow: 'rgba(22, 163, 74, 0.2)',
  textTitleGrad: ['#ffffff', '#4ade80'],
  textTagline: 'rgba(255, 255, 255, 0.9)',
};

export const galaxyEmeraldTheme: ThemeColors = {
  id: 'galaxy-emerald',
  name: 'Galaxy Emerald',
  bg: GALAXY_BG,
  skyGradient: GALAXY_SKY,
  horizonGlow: '#064e3b',
  mistColor: GALAXY_MIST,
  groundColor1: '#020617',
  groundColor2: '#000000',
  treeBarkGrad: ['#065f46', '#064e3b', '#022c22'],
  foliageColor: GREEN_FOLIAGE,
  particleColors: ['rgba(34, 197, 94, 1)', 'rgba(52, 211, 153, 0.8)'],
  btnGradient: ['#10b981', '#059669'],
  btnShadow: 'rgba(16, 185, 129, 0.15)',
  textTitleGrad: ['#10b981', '#34d399'],
  textTagline: '#6ee7b7',
};

export const galaxySteelTheme: ThemeColors = {
  id: 'galaxy-steel',
  name: 'Galaxy Steel',
  bg: GALAXY_BG,
  skyGradient: GALAXY_SKY,
  horizonGlow: '#1e293b',
  mistColor: GALAXY_MIST,
  groundColor1: '#020617',
  groundColor2: '#000000',
  treeBarkGrad: ['#334155', '#1e293b', '#0f172a'],
  foliageColor: GREEN_FOLIAGE,
  particleColors: ['rgba(34, 197, 94, 1)', 'rgba(148, 163, 184, 0.8)'],
  btnGradient: ['#475569', '#1e293b'],
  btnShadow: 'rgba(71, 85, 105, 0.2)',
  textTitleGrad: ['#94a3b8', '#f8fafc'],
  textTagline: '#cbd5e1',
};

export const allThemes = [purpleTheme, galaxySunsetTheme, galaxyEmeraldTheme, galaxySteelTheme];
