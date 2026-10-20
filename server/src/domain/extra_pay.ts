/** Extra pay: the Easter, summer and Christmas bonuses of 14 salaries a year. */

import * as db from "../data/db.js";
import { type Conn, type Row } from "../data/db.js";
import { monthName, PyDate, pyMod, pyRound, sorted } from "../utils/python.js";
import { getPlan } from "./plan.js";
import { localToday } from "./months.js";

/** Greek Easter: the Julian computus, moved to the Gregorian calendar (13 days, 1900-2099). */
export function orthodoxEaster(y: number): PyDate {
  const a = y % 4, b = y % 7, c = y % 19;
  const d = (19 * c + 15) % 30;
  const e = pyMod(2 * a + 4 * b - d + 34, 7);
  const month = Math.floor((d + e + 114) / 31), day = (d + e + 114) % 31;
  return new PyDate(y, month, day + 1).addDays(13);
}

/** The next three bonuses, soonest first, when 14 salaries is on. Rough amounts from your pay: a month at
 * Christmas, half a month at Easter and in summer. The monthly budget doesn't count on them. */
export async function extraPay(conn: Conn): Promise<Row[]> {
  if (!(await db.getMeta(conn, "settings"))?.extra_pay) return [];
  const plan = await getPlan(conn);
  const pay = plan ? plan.take_home : 0;
  const today = localToday();
  let out: Row[] = [];
  for (const y of [today.year, today.year + 1]) {
    out.push(
      { name: "Easter bonus", amount: pyRound(pay / 2), date: orthodoxEaster(y).addDays(-4).isoformat(), when: "before Easter" },
      { name: "Summer bonus", amount: pyRound(pay / 2), date: new PyDate(y, 6, 30).isoformat(), when: "usually by the end of June" },
      { name: "Christmas bonus", amount: pyRound(pay), date: new PyDate(y, 12, 21).isoformat(), when: "by 21 December" },
    );
  }
  out = sorted(out.filter((b) => b.date >= today.isoformat()), (b) => b.date).slice(0, 3);
  for (const b of out) {
    const d = PyDate.fromisoformat(b.date);
    const day = `${d.day} ${monthName(d)}` + (d.year !== today.year ? ` ${d.year}` : "");
    b.when = ({ "before Easter": `By ${day}, before Easter`, "by 21 December": `By ${day}` } as Record<string, string>)[b.when] ?? `Usually by ${day}`;
  }
  return out;
}
