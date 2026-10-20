/** Date arithmetic on PyDate. */

import { monthDays, PyDate, pyMod } from "./python.js";

/** The same day n months on, or the month's last day when it has fewer. */
export function addMonths(d: PyDate, n: number): PyDate {
  const i = d.month - 1 + n;
  const y = d.year + Math.floor(i / 12), m = pyMod(i, 12) + 1;
  return new PyDate(y, m, Math.min(d.day, monthDays(y, m)));
}
