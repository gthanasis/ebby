import { useId } from "react";

/** ebby's mark: a coin, and the water in it is what's left of the month's money. On the login it's
 * drawn live: the water rises in and its wave keeps drifting. The app icons are the same drawing
 * (scripts/make-icons.py). Colours come from the theme, so it follows light and dark. */
export function Logo({ className, live = false }: { className?: string; live?: boolean }) {
  const clip = useId();
  return (
    <svg className={`logo ${live ? "live" : ""} ${className ?? ""}`} viewBox="0 0 64 64" aria-hidden="true">
      <defs><clipPath id={clip}><circle cx="32" cy="32" r="30" /></clipPath></defs>
      <circle cx="32" cy="32" r="30" fill="var(--accent)" />
      <g clipPath={`url(#${clip})`}>
        <g className="logo-water">
          {/* Two wavelengths wide, so drifting one wavelength loops without a seam. */}
          <path className="logo-wave" d="M-64 39 C-54 33 -42 33 -32 39 S-10 45 0 39 C10 33 22 33 32 39 S54 45 64 39 V64 H-64Z" fill="var(--accent-contrast)" />
        </g>
      </g>
      <path className="logo-crest" d="M7 28 C15 23.5 24 23.5 32 28 S49 32.5 57 28" fill="none" stroke="var(--accent-contrast)"
        strokeOpacity=".45" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}
