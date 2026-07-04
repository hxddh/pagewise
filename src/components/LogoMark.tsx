import { LOGO_MARK_SHAPES, LOGO_MARK_VIEWBOX } from "../lib/logo-mark-assets";

interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 28, className }: LogoMarkProps) {
  const { backPage, frontPage, dot } = LOGO_MARK_SHAPES;
  return (
    <svg
      width={size}
      height={size}
      viewBox={LOGO_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <rect
        x={backPage.x}
        y={backPage.y}
        width={backPage.width}
        height={backPage.height}
        rx={backPage.rx}
        fill="currentColor"
        opacity={backPage.opacity}
      />
      <rect
        x={frontPage.x}
        y={frontPage.y}
        width={frontPage.width}
        height={frontPage.height}
        rx={frontPage.rx}
        fill="currentColor"
      />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} fill="var(--success, #3dd68c)" />
    </svg>
  );
}
