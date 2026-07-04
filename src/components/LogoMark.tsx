interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 28, className }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <rect x="4" y="7" width="14" height="17" rx="2" fill="currentColor" opacity="0.22" />
      <rect x="8" y="4" width="14" height="17" rx="2" fill="currentColor" />
      <circle cx="18" cy="17" r="2.5" fill="var(--success, #3dd68c)" />
    </svg>
  );
}
