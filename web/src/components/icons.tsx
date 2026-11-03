import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const Play = (p: P) => (
  <Svg {...p}><path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" /></Svg>
);
export const Pause = (p: P) => (
  <Svg {...p}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></Svg>
);
export const Back = (p: P) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>;
export const Plus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const Trash = (p: P) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
export const Loop = (p: P) => <Svg {...p}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 01-4 4H4" /></Svg>;
export const Metronome = (p: P) => <Svg {...p}><path d="M8 21h8l-3-17h-2zM12 14l6-8" /></Svg>;
export const Upload = (p: P) => <Svg {...p}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></Svg>;
export const Download = (p: P) => <Svg {...p}><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></Svg>;
export const Wand = (p: P) => <Svg {...p}><path d="M15 4V2M15 10V8M11 6h2M17 6h2M4 20L14 10M18 13l1 1M19 2l1 1" /></Svg>;
export const Scissors = (p: P) => <Svg {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></Svg>;
export const More = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></Svg>;
export const ListIcon = (p: P) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Svg>;
export const Expand = (p: P) => <Svg {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></Svg>;
export const Next = (p: P) => <Svg {...p}><path d="M5 4l10 8-10 8zM19 5v14" /></Svg>;
export const Prev = (p: P) => <Svg {...p}><path d="M19 20L9 12l10-8zM5 19V5" /></Svg>;
export const Copy = (p: P) => <Svg {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" /></Svg>;
export const Grip = (p: P) => <Svg {...p}><circle cx="9" cy="6" r="1" fill="currentColor" /><circle cx="15" cy="6" r="1" fill="currentColor" /><circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" /><circle cx="9" cy="18" r="1" fill="currentColor" /><circle cx="15" cy="18" r="1" fill="currentColor" /></Svg>;
export const X = (p: P) => <Svg {...p}><path d="M18 6L6 18M6 6l12 12" /></Svg>;
