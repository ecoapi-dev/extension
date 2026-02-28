interface LeafIconProps {
  size?: number;
  className?: string;
  animated?: boolean;
}

export function LeafIcon({ size = 64, className = "", animated = false }: LeafIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={`${className} ${animated ? "animate-pulse" : ""}`}
    >
      <path
        d="M32 8C32 8 16 16 12 32C8 48 24 56 32 56C32 56 32 40 32 32C32 24 40 16 48 12C48 12 40 8 32 8Z"
        fill="#4EAA57"
        opacity="0.9"
      />
      <path
        d="M32 56C32 56 32 40 32 32C32 24 40 16 48 12"
        stroke="#2D7A35"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M26 36C28 32 30 30 32 28"
        stroke="#2D7A35"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M22 42C25 38 28 35 32 33"
        stroke="#2D7A35"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function SmallLeafIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M8 2C8 2 4 4 3 8C2 12 6 14 8 14C8 14 8 10 8 8C8 6 10 4 12 3C12 3 10 2 8 2Z"
        fill="#4EAA57"
      />
    </svg>
  );
}
