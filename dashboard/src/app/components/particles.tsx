import { useEffect, useRef } from 'react';
import { useTheme } from '../theme-context';

interface Particle {
  x: number;
  y: number;
  size: number;
  vx: number;
  vy: number;
  opacity: number;
  fadeDir: number;
  time: number;
  color: string;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  color: string;
}

export function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const theme = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const particles: Particle[] = [];
    const ripples: Ripple[] = [];
    const count = 70;
    const attractRadius = 150;
    const scatterRadius = 200;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleClick = (e: MouseEvent) => {
      const cx = e.clientX;
      const cy = e.clientY;

      // Scatter nearby particles outward
      for (const p of particles) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < scatterRadius && dist > 0) {
          const force = ((scatterRadius - dist) / scatterRadius) * 3.5;
          const angle = Math.atan2(dy, dx);
          p.vx += Math.cos(angle) * force;
          p.vy += Math.sin(angle) * force;
        }
      }

      // Spawn ripple ring
      ripples.push({
        x: cx,
        y: cy,
        radius: 0,
        maxRadius: scatterRadius * 0.6,
        alpha: 0.5,
        color: theme.particleColors[0].match(/\d+/g)?.slice(0, 3).join(',') || '255,255,255',
      });
    };

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleClick);

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 2 + 0.5,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        opacity: Math.random() * 0.5,
        fadeDir: Math.random() > 0.5 ? 1 : -1,
        time: Math.random() * 100,
        color: theme.particleColors[Math.floor(Math.random() * theme.particleColors.length)],
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw ripples
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.radius += 4;
        r.alpha -= 0.015;
        if (r.alpha <= 0 || r.radius >= r.maxRadius) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r.color}, ${r.alpha})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Draw particles
      for (const p of particles) {
        // Natural wandering
        p.time += 0.01;
        p.vx += Math.sin(p.time) * 0.01;
        p.vy += Math.cos(p.time) * 0.01;

        // Attract toward cursor
        const dx = mouseRef.current.x - p.x;
        const dy = mouseRef.current.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < attractRadius) {
          const force = (attractRadius - dist) / attractRadius;
          const angle = Math.atan2(dy, dx);
          p.vx += Math.cos(angle) * force * 0.05;
          p.vy += Math.sin(angle) * force * 0.05;
        }

        // Damping
        p.vx *= 0.98;
        p.vy *= 0.98;
        p.x += p.vx;
        p.y += p.vy;

        // Fade
        p.opacity += p.fadeDir * 0.002;
        if (p.opacity > 0.6) p.fadeDir = -1;
        if (p.opacity < 0.1) p.fadeDir = 1;

        // Screen wrap
        if (p.x < -50) p.x = canvas.width + 50;
        if (p.x > canvas.width + 50) p.x = -50;
        if (p.y < -50) p.y = canvas.height + 50;
        if (p.y > canvas.height + 50) p.y = -50;

        // Glow halo
        const rgb = p.color.match(/\d+/g)?.slice(0, 3).join(',') || '255,255,255';
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
        gradient.addColorStop(0, `rgba(${rgb}, ${p.opacity})`);
        gradient.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Core dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity * 1.5})`;
        ctx.fill();
      }

      animId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleClick);
    };
  }, [theme]);

  return <canvas ref={canvasRef} className="absolute inset-0 z-[2] pointer-events-none" />;
}
