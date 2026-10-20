import { useState } from "react";

/** A button's request: `busy` while it runs, the error's message if it fails. `keepBusy` stays busy after it
 * succeeds, for an action that navigates away and shouldn't be pressed twice on the way. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>, { keepBusy = false } = {}) => {
    setBusy(true); setError(null);
    const p = action().catch((e: Error) => { setError(e.message); if (keepBusy) setBusy(false); });
    if (!keepBusy) p.finally(() => setBusy(false));
  };
  return { busy, error, setError, run };
}
