import { useState } from "react";

/** A small per-device choice (like which view a card shows) kept across visits. Storage can be
 * unavailable (private mode, blocked site data); then it simply lasts until the page reloads. */
export function useRemembered<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T | null) ?? fallback; } catch { return fallback; }
  });
  const set = (v: T) => {
    setValue(v);
    try { localStorage.setItem(key, v); } catch { /* keep it in memory */ }
  };
  return [value, set];
}
