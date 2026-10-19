import { useEffect, useState } from "react";
import { useApi, type Category, type Me, type Range, type Status } from "../lib/api";
import { setThisMonth, thisMonth } from "../lib/format";
import { Accounts } from "./Accounts";
import { CategoryView } from "./CategoryView";
import { Goals } from "./Goals";
import { HomeScreen } from "./Home";
import { SettingsScreen } from "./Settings";
import { Sorter } from "./Sorter";
import { Spending } from "./Spending";
import { SubscriptionsScreen } from "./Subscriptions";
import { Transactions } from "./Transactions";
import { Icon } from "./ui";
import { ServiceView } from "./ServiceView";
import { CommittedView } from "./Committed";
import { AssistantScreen } from "./Assistant";
import { Login } from "./Login";
import { Onboarding } from "./Onboarding";

export type Page = "home" | "assistant" | "spending" | "committed" | "category" | "service" | "subscriptions" | "transactions" | "year" | "goals" | "plan" | "settings" | "accounts" | "login" | "welcome";
export interface Route {
  page: Page; month: string; category?: string; service?: string; commitment?: number; id?: number; view?: "month" | "year"; year?: number; section?: string;
  /** Spending's period: a day, week, pay month or year, `off` steps back from the current one. */
  range?: Range; off?: number;
}
const RANGES: Range[] = ["day", "week", "month", "year"];
const monthsBack = (m: string) => {
  const [y, mo] = m.split("-").map(Number), [ty, tm] = thisMonth().split("-").map(Number);
  return (y - ty) * 12 + (mo - tm);
};

const PAGES: Page[] = ["home", "assistant", "spending", "committed", "category", "service", "subscriptions", "transactions", "year", "goals", "plan", "settings", "accounts", "login", "welcome"];

function parseHash(): Route {
  const [page, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const params = new URLSearchParams(rest.join("/"));
  // "overview" was the old landing page; old links and installs still open it.
  const p = (PAGES as string[]).includes(page) ? (page as Page) : "home";
  return {
    page: p,
    month: params.get("month") ?? thisMonth(),
    category: params.get("category") ?? undefined,
    service: params.get("service") ?? undefined,
    commitment: params.get("commitment") ? Number(params.get("commitment")) : undefined,
    id: params.get("id") ? Number(params.get("id")) : undefined,
    // The old Year tab now lives inside Spending.
    view: page === "year" || params.get("view") === "year" ? "year" : undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
    section: params.get("section") ?? undefined,
    // Old links name a month or the Year page; they open the same period here.
    range: (RANGES as string[]).includes(params.get("range") ?? "") ? (params.get("range") as Range)
      : page === "year" || params.get("view") === "year" ? "year" : "month",
    off: params.get("off") ? Math.min(0, Number(params.get("off")) || 0) : params.get("month") ? Math.min(0, monthsBack(params.get("month")!)) : 0,
  };
}

export function hrefFor(r: Partial<Route> & { page: Page }) {
  const params = new URLSearchParams();
  if (r.month && r.month !== thisMonth()) params.set("month", r.month);
  if (r.category) params.set("category", r.category);
  if (r.service) params.set("service", r.service);
  if (r.commitment != null) params.set("commitment", String(r.commitment));
  if (r.id != null) params.set("id", String(r.id));
  if (r.view === "year") params.set("view", "year");
  if (r.year) params.set("year", String(r.year));
  if (r.section) params.set("section", r.section);
  if (r.range && r.range !== "month") params.set("range", r.range);
  if (r.off) params.set("off", String(r.off));
  return `#/${r.page}/${params}`;
}

const TABS: { page: Page; label: string; icon: string; covers: Page[] }[] = [
  { page: "home", label: "Overview", icon: "mdi:home-outline", covers: ["home"] },
  { page: "spending", label: "Spending", icon: "mdi:chart-donut", covers: ["spending", "year", "committed", "category", "service", "subscriptions", "transactions"] },
  { page: "assistant", label: "Assistant", icon: "mdi:creation-outline", covers: ["assistant"] },
  { page: "goals", label: "Goals", icon: "mdi:flag-checkered", covers: ["goals"] },
  { page: "settings", label: "Settings", icon: "mdi:cog-outline", covers: ["settings", "plan", "accounts"] },
];

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [version, setVersion] = useState(0);
  const status = useApi<Status>("/api/status", version);
  const me = useApi<Me>(route.page === "login" ? null : "/api/me");
  // Set as soon as Done is pressed, so the tabs don't wait for /api/me to say so.
  const [finished, setFinished] = useState(false);
  const onboarding = me.data && !me.data.onboarding.done && !finished;
  const settled = !!me.data || !!me.error;
  useEffect(() => {
    if (route.page === "welcome" && settled && !onboarding) location.replace(hrefFor({ page: "home" }));
  }, [route.page, settled, onboarding]);
  const categories = useApi<Category[]>("/api/categories");
  const syncing = status.data?.syncing ?? false;

  useEffect(() => {
    const on = () => { setRoute(parseHash()); scrollTo(0, 0); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // The server knows the pay month; re-read the route once it says, so "this month" means that one.
  const serverMonth = status.data?.month;
  useEffect(() => {
    if (serverMonth && serverMonth !== thisMonth()) { setThisMonth(serverMonth); setRoute(parseHash()); }
  }, [serverMonth]);

  // Poll while a sync runs, then refresh everything once it finishes.
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(status.reload, 3000);
    return () => { clearInterval(t); setVersion((v) => v + 1); };
  }, [syncing, status.reload]);

  const go = (r: Partial<Route>) => { location.hash = hrefFor({ ...route, ...r }); };
  const list = categories.data ?? [];
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  const changed = () => setVersion((v) => v + 1);
  const shared = { byId, version, go };

  if (route.page === "login") return <Login />;
  // Until /api/me answers, draw nothing rather than flash the tabs at someone who still has setup to do.
  // A server without /api/me (an error other than 401) keeps the app as it was.
  if (!settled) return null;
  if (onboarding) {
    return <Onboarding me={me.data!} status={status.data} reloadMe={me.reload} reloadStatus={status.reload}
      onDone={() => { setFinished(true); changed(); location.hash = hrefFor({ page: "home" }); }} />;
  }

  return (
    <div className="shell">
      <div className="wrap narrow">
        {route.page === "assistant" && (route.section === "sort"
          ? <Sorter {...shared} onChanged={() => { changed(); status.reload(); }} />
          : <AssistantScreen {...shared} onChanged={() => { changed(); status.reload(); }} />)}
        {route.page === "home" && <HomeScreen {...shared} status={status.data} onSync={status.reload} />}
        {(route.page === "spending" || route.page === "year") && <Spending {...shared} range={route.range ?? "month"} off={route.off ?? 0} />}
        {route.page === "committed" && <CommittedView {...shared} month={route.month} onChanged={changed} />}
        {route.page === "category" && route.category && <CategoryView {...shared} range={route.range ?? "month"} off={route.off ?? 0} category={route.category} />}
        {route.page === "service" && route.category && route.service && (
          <ServiceView {...shared} month={route.month} category={route.category} service={route.service} />
        )}
        {route.page === "subscriptions" && <SubscriptionsScreen {...shared} />}
        {route.page === "transactions" && (
          <Transactions month={route.month} category={route.category} service={route.service} commitment={route.commitment} categories={list} byId={byId}
            version={version} onChanged={changed} go={go} />
        )}
        {route.page === "goals" && <Goals {...shared} section={route.section} id={route.id} onChanged={changed} />}
        {(route.page === "settings" || route.page === "plan") && (
          <SettingsScreen {...shared} section={route.section} commitment={route.commitment} status={status.data} reloadStatus={status.reload} onChanged={changed}
            me={me.data} reloadMe={me.reload} />
        )}
        {route.page === "accounts" && (
          <>
            <a className="back" href={hrefFor({ page: "settings" })}><Icon icon="mdi:chevron-left" />Settings</a>
            <div className="hello"><h1>Banks</h1></div>
            <Accounts status={status.data} reload={status.reload} />
          </>
        )}
      </div>

      <nav className="tabbar" aria-label="Sections" style={{ ["--tabs" as string]: TABS.length }}>
        {TABS.map((t) => {
          const on = t.covers.includes(route.page);
          return (
            <a key={t.page} className={on ? "on" : ""} aria-current={on ? "page" : undefined} href={hrefFor({ page: t.page })}>
              <Icon icon={t.icon} />{t.label}
              {t.page === "assistant" && !!status.data?.questions && <span className="badge num" aria-label={`${status.data.questions} questions`}>{status.data.questions}</span>}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

export interface ScreenProps {
  byId: Record<string, Category>;
  version: number;
  go: (r: Partial<Route>) => void;
}
