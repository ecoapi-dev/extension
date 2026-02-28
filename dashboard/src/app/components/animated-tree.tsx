import { motion as Motion } from 'motion/react';
import { useTheme } from '../theme-context';

export function AnimatedTree() {
  const theme = useTheme();

  return (
    <>
      {/* ===== FULL-WIDTH GROUND / HILL ===== */}
      <svg
        viewBox="0 0 1000 200"
        className="absolute bottom-0 left-0 w-full pointer-events-none"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
        style={{ zIndex: 3, height: '22vh' }}
      >
        <path
          d="M0 120 Q500 60 1000 120 L1000 200 L0 200 Z"
          fill={theme.groundColor1}
        />
        <path
          d="M0 150 Q500 110 1000 150 L1000 200 L0 200 Z"
          fill={theme.groundColor2}
        />
      </svg>

      {/* ===== IMPROVED GNARLY TREE ===== */}
      <svg
        viewBox="0 0 1000 1000"
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[90%] max-w-[850px] pointer-events-none"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMax meet"
        style={{ zIndex: 4 }}
      >
        <defs>
          <linearGradient id="treeBarkGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={theme.treeBarkGrad[0]} />
            <stop offset="40%" stopColor={theme.treeBarkGrad[1]} />
            <stop offset="100%" stopColor={theme.treeBarkGrad[2]} />
          </linearGradient>

          <filter id="trunkShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feOffset dx="-2" dy="2" />
            <feComposite in2="SourceAlpha" operator="in" />
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g style={{ transformOrigin: '500px 920px' }}>
          <g filter="url(#trunkShadow)">
            <path
              d="M450 920
                 Q460 850 475 800
                 Q495 720 480 650
                 Q460 580 430 540
                 L440 535 Q465 570 485 620
                 Q500 660 500 730
                 Q500 660 515 620
                 Q535 570 560 535
                 L570 540 Q540 580 520 650
                 Q505 720 525 800
                 Q540 850 550 920 Z"
              fill="url(#treeBarkGrad)"
            />
            <path d="M480 650 Q460 660 440 640" stroke="url(#treeBarkGrad)" strokeWidth="20" strokeLinecap="round" fill="none" />
            <path d="M520 650 Q540 660 560 640" stroke="url(#treeBarkGrad)" strokeWidth="20" strokeLinecap="round" fill="none" />
            <path d="M500 680 Q500 650 500 630" stroke="url(#treeBarkGrad)" strokeWidth="18" strokeLinecap="round" fill="none" />
            <path d="M495 850 Q500 840 505 850" stroke="rgba(255,255,255,0.05)" fill="none" strokeWidth="1.5" />
            <path d="M505 780 Q510 770 515 780" stroke="rgba(255,255,255,0.05)" fill="none" strokeWidth="1.5" />
            <path d="M485 720 Q490 710 495 720" stroke="rgba(255,255,255,0.05)" fill="none" strokeWidth="1.5" />
          </g>

          <g style={{ transformOrigin: '475px 650px' }}>
            <path d="M475 650 Q430 630 380 600 Q330 540 250 540" stroke="url(#treeBarkGrad)" strokeWidth="18" strokeLinecap="round" fill="none" />
            <path d="M380 600 Q360 640 300 660" stroke="url(#treeBarkGrad)" strokeWidth="8" strokeLinecap="round" fill="none" />
            <path d="M330 550 Q300 500 240 480" stroke="url(#treeBarkGrad)" strokeWidth="6" strokeLinecap="round" fill="none" />
            <FoliageCluster x={250} y={540} scale={1.2} delay={0.2} color={theme.foliageColor} />
            <FoliageCluster x={300} y={660} scale={0.8} delay={0.8} color={theme.foliageColor} />
            <FoliageCluster x={240} y={480} scale={0.9} delay={1.2} color={theme.foliageColor} />
          </g>

          <g style={{ transformOrigin: '525px 650px' }}>
            <path d="M525 650 Q570 630 620 600 Q670 540 750 540" stroke="url(#treeBarkGrad)" strokeWidth="18" strokeLinecap="round" fill="none" />
            <path d="M620 600 Q640 640 700 660" stroke="url(#treeBarkGrad)" strokeWidth="8" strokeLinecap="round" fill="none" />
            <path d="M670 550 Q700 500 760 480" stroke="url(#treeBarkGrad)" strokeWidth="6" strokeLinecap="round" fill="none" />
            <FoliageCluster x={750} y={540} scale={1.2} delay={0.3} color={theme.foliageColor} />
            <FoliageCluster x={700} y={660} scale={0.8} delay={1.1} color={theme.foliageColor} />
            <FoliageCluster x={760} y={480} scale={0.9} delay={1.5} color={theme.foliageColor} />
          </g>

          <g style={{ transformOrigin: '500px 650px' }}>
            <path d="M500 650 Q500 580 500 450" stroke="url(#treeBarkGrad)" strokeWidth="16" strokeLinecap="round" fill="none" />
            <path d="M500 550 Q440 500 400 420" stroke="url(#treeBarkGrad)" strokeWidth="10" strokeLinecap="round" fill="none" />
            <path d="M500 550 Q560 500 600 420" stroke="url(#treeBarkGrad)" strokeWidth="10" strokeLinecap="round" fill="none" />
            <FoliageCluster x={500} y={450} scale={1.4} delay={0.1} color={theme.foliageColor} />
            <FoliageCluster x={400} y={420} scale={1.1} delay={0.6} color={theme.foliageColor} />
            <FoliageCluster x={600} y={420} scale={1.1} delay={0.9} color={theme.foliageColor} />
          </g>

          <FoliageCluster x={500} y={350} scale={1.3} delay={0.4} color={theme.foliageColor} />
          <FoliageCluster x={440} y={380} scale={0.9} delay={1.3} color={theme.foliageColor} />
          <FoliageCluster x={560} y={380} scale={0.9} delay={1.6} color={theme.foliageColor} />
          <FoliageCluster x={470} y={320} scale={0.8} delay={0.7} color={theme.foliageColor} />
          <FoliageCluster x={530} y={320} scale={0.8} delay={0.9} color={theme.foliageColor} />
          <FoliageCluster x={450} y={410} scale={0.95} delay={0.5} color={theme.foliageColor} />
          <FoliageCluster x={550} y={410} scale={0.95} delay={0.8} color={theme.foliageColor} />

          <FoliageCluster x={450} y={550} scale={1.0} delay={0.5} color={theme.foliageColor} />
          <FoliageCluster x={550} y={550} scale={1.0} delay={0.8} color={theme.foliageColor} />
          <FoliageCluster x={500} y={600} scale={0.9} delay={1.1} color={theme.foliageColor} />
          <FoliageCluster x={420} y={480} scale={0.85} delay={1.4} color={theme.foliageColor} />
          <FoliageCluster x={580} y={480} scale={0.85} delay={1.7} color={theme.foliageColor} />
          <FoliageCluster x={500} y={520} scale={1.2} delay={0.1} color={theme.foliageColor} />

          <FoliageCluster x={360} y={520} scale={0.95} delay={0.3} color={theme.foliageColor} />
          <FoliageCluster x={320} y={580} scale={0.8} delay={1.2} color={theme.foliageColor} />
          <FoliageCluster x={640} y={520} scale={0.95} delay={0.6} color={theme.foliageColor} />
          <FoliageCluster x={680} y={580} scale={0.8} delay={1.5} color={theme.foliageColor} />
          <FoliageCluster x={340} y={450} scale={0.9} delay={0.45} color={theme.foliageColor} />
          <FoliageCluster x={660} y={450} scale={0.9} delay={0.75} color={theme.foliageColor} />
          <FoliageCluster x={420} y={640} scale={0.85} delay={0.4} color={theme.foliageColor} />
          <FoliageCluster x={580} y={640} scale={0.85} delay={0.9} color={theme.foliageColor} />
        </g>

        <FallingLeaf startX={380} startY={500} delay={2} color={theme.treeBarkGrad[0]} />
        <FallingLeaf startX={620} startY={450} delay={5} color={theme.treeBarkGrad[0]} />
        <FallingLeaf startX={500} startY={400} delay={8} color={theme.treeBarkGrad[0]} />
      </svg>
    </>
  );
}

function FallingLeaf({ startX, startY, delay, color }: { startX: number; startY: number; delay: number; color: string }) {
  return (
    <Motion.path
      d="M0 0 C2 2 4 0 6 2 C4 4 2 4 0 2 Z"
      fill={color}
      initial={{ x: startX, y: startY, opacity: 0, rotate: 0 }}
      animate={{
        x: [startX, startX + 70, startX - 30, startX + 40],
        y: [startY, startY + 250, startY + 500, startY + 750],
        rotate: [0, 180, 360, 540, 720],
        opacity: [0, 0.7, 0.7, 0]
      }}
      transition={{
        duration: 14,
        repeat: Infinity,
        delay,
        ease: "linear"
      }}
    />
  );
}

function FoliageCluster({ x, y, scale = 1, delay = 0, color }: { x: number; y: number; scale?: number; delay?: number; color: string }) {
  return (
    <Motion.g
      style={{ transformOrigin: `${x}px ${y}px` }}
      animate={{
        scale: [1, 1.03, 0.97, 1],
        rotate: [-1.5, 1.5, -0.8, 0.8, -1.5]
      }}
      transition={{ duration: 7 + delay, repeat: Infinity, ease: 'easeInOut', delay }}
    >
      <g transform={`translate(${x}, ${y}) scale(${scale})`}>
        <circle cx="0" cy="0" r="48" fill={color} />
        <circle cx="-35" cy="-25" r="38" fill={color} />
        <circle cx="35" cy="-25" r="38" fill={color} />
        <circle cx="0" cy="-45" r="32" fill={color} />
        <circle cx="-45" cy="18" r="32" fill={color} />
        <circle cx="45" cy="18" r="32" fill={color} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
          <circle
            key={i}
            cx={Math.cos(angle * Math.PI / 180) * 48}
            cy={Math.sin(angle * Math.PI / 180) * 48}
            r="14"
            fill={color}
          />
        ))}
      </g>
    </Motion.g>
  );
}
