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

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props} strokeWidth="1.25">
      <path d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />
      <path d="M12.9 8.8l.9-.5a.6.6 0 0 0 .2-.8l-.8-1.4a.6.6 0 0 0-.7-.3l-1 .3a4.8 4.8 0 0 0-.8-.5l-.2-1.1a.6.6 0 0 0-.6-.5H8.1a.6.6 0 0 0-.6.5l-.2 1.1c-.3.1-.5.3-.8.5l-1-.3a.6.6 0 0 0-.7.3l-.8 1.4a.6.6 0 0 0 .2.8l.9.5a4.5 4.5 0 0 0 0 1l-.9.5a.6.6 0 0 0-.2.8l.8 1.4c.2.3.5.4.7.3l1-.3c.3.2.5.4.8.5l.2 1.1c.1.3.3.5.6.5h1.8c.3 0 .5-.2.6-.5l.2-1.1c.3-.1.5-.3.8-.5l1 .3c.3.1.6 0 .7-.3l.8-1.4a.6.6 0 0 0-.2-.8l-.9-.5a4.5 4.5 0 0 0 0-1z" />
    </Icon>
  );
}

export function IconCommand(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 3.5h5M5.5 8h5M5.5 12.5h5" />
    </Icon>
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

export function IconMore(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="8" r="1.2" />
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

export function IconAgent(props: IconProps) {
  return (
    <Icon {...props} strokeWidth="1.25">
      <path d="M3.5 4.5h9a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2H6.2L3.5 13.5V5.7a1.2 1.2 0 0 1 1.2-1.2z" />
      <path d="M6 8h4M6 10.2h2.5" />
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
