import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3L5 8l5 5" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3l5 5-5 5" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.2l3 3 6-6.5" />
    </Icon>
  );
}

export function IconDot({ connected, ...props }: IconProps & { connected?: boolean }) {
  return (
    <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden {...props}>
      <circle
        cx="4"
        cy="4"
        r="3"
        fill={connected ? "var(--success)" : "var(--text-muted)"}
      />
    </svg>
  );
}
