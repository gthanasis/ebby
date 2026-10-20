import {
  mdiAccountArrowRightOutline, mdiAirplane, mdiAlertCircleOutline, mdiArrowDownCircleOutline, mdiBankOutline,
  mdiCarOutline, mdiCartOutline, mdiCash, mdiChartBar, mdiChevronLeft, mdiChevronRight, mdiCoffeeOutline,
  mdiContentCut, mdiCreditCardCheckOutline, mdiCreditCardOutline, mdiDotsHorizontal, mdiFileDocumentOutline,
  mdiFormatListBulleted, mdiHeartPulse, mdiHomeOutline, mdiLaptop, mdiLinkVariant, mdiMagnify, mdiMopedOutline,
  mdiOpenInNew, mdiPaw, mdiPawOutline, mdiShoppingOutline, mdiSilverwareForkKnife, mdiStorefrontOutline,
  mdiCashMultiple, mdiCellphone, mdiChartPie, mdiCheck, mdiPiggyBankOutline, mdiStairsDown, mdiSwapHorizontal, mdiSync, mdiTicketOutline, mdiTrendingDown, mdiTrendingUp, mdiWalletOutline, mdiCalendarMonthOutline,
mdiThermometerAlert, mdiSnowflake, mdiCreationOutline, mdiFlagCheckered, mdiChartDonut, mdiCogOutline, mdiRepeat, mdiPlus, mdiTarget, mdiBellOutline, mdiCheckCircleOutline, mdiCloudOutline, mdiPencilOutline, mdiDeleteOutline, mdiMinus, mdiClose, mdiArrowUp, mdiChevronDown,
mdiHistory, mdiMessageTextOutline, mdiHelpCircleOutline, mdiCalendarRemoveOutline, mdiClockOutline, mdiShieldCheckOutline, mdiGiftOutline, mdiGoogle,
  mdiBankTransferOut, mdiBabyFaceOutline, mdiSchoolOutline, mdiChartLine,
mdiContentCopy, mdiFileKeyOutline, mdiKeyOutline, mdiAccountOutline, mdiArrowRight, mdiTrayArrowUp, mdiTimerOutline, mdiLockOutline,
mdiLogout, mdiAccountPlusOutline, mdiAccountCheckOutline, mdiAccountOffOutline, mdiAccountGroupOutline, mdiTuneVariant,
} from "@mdi/js";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { isAllowanceError } from "../lib/api";
import { euroRound } from "../lib/format";

/** Icons are referenced by mdi name (the backend sends them per category) and drawn from @mdi/js. */
const ICONS: Record<string, string> = {
  "mdi:account-arrow-right-outline": mdiAccountArrowRightOutline, "mdi:airplane": mdiAirplane,
  "mdi:alert-circle-outline": mdiAlertCircleOutline, "mdi:arrow-down-circle-outline": mdiArrowDownCircleOutline,
  "mdi:bank-outline": mdiBankOutline, "mdi:car-outline": mdiCarOutline, "mdi:cart-outline": mdiCartOutline, "mdi:cash": mdiCash,
  "mdi:chart-bar": mdiChartBar, "mdi:chevron-left": mdiChevronLeft, "mdi:chevron-right": mdiChevronRight,
  "mdi:coffee-outline": mdiCoffeeOutline, "mdi:content-cut": mdiContentCut, "mdi:credit-card-check-outline": mdiCreditCardCheckOutline,
  "mdi:credit-card-outline": mdiCreditCardOutline, "mdi:dots-horizontal": mdiDotsHorizontal,
  "mdi:file-document-outline": mdiFileDocumentOutline, "mdi:format-list-bulleted": mdiFormatListBulleted,
  "mdi:heart-pulse": mdiHeartPulse, "mdi:home-outline": mdiHomeOutline, "mdi:laptop": mdiLaptop, "mdi:link-variant": mdiLinkVariant,
  "mdi:magnify": mdiMagnify, "mdi:moped-outline": mdiMopedOutline, "mdi:open-in-new": mdiOpenInNew, "mdi:paw": mdiPaw,
  "mdi:paw-outline": mdiPawOutline, "mdi:shopping-outline": mdiShoppingOutline, "mdi:silverware-fork-knife": mdiSilverwareForkKnife,
  "mdi:storefront-outline": mdiStorefrontOutline, "mdi:swap-horizontal": mdiSwapHorizontal, "mdi:sync": mdiSync,
  "mdi:ticket-outline": mdiTicketOutline, "mdi:trending-down": mdiTrendingDown, "mdi:trending-up": mdiTrendingUp,
  "mdi:wallet-outline": mdiWalletOutline,
  "mdi:thermometer-alert": mdiThermometerAlert, "mdi:snowflake": mdiSnowflake, "mdi:creation-outline": mdiCreationOutline, "mdi:flag-checkered": mdiFlagCheckered, "mdi:chart-donut": mdiChartDonut, "mdi:cog-outline": mdiCogOutline, "mdi:repeat": mdiRepeat, "mdi:plus": mdiPlus, "mdi:target": mdiTarget, "mdi:bell-outline": mdiBellOutline, "mdi:check-circle-outline": mdiCheckCircleOutline, "mdi:cloud-outline": mdiCloudOutline, "mdi:pencil-outline": mdiPencilOutline, "mdi:delete-outline": mdiDeleteOutline, "mdi:minus": mdiMinus, "mdi:close": mdiClose, "mdi:arrow-up": mdiArrowUp, "mdi:chevron-down": mdiChevronDown, "mdi:calendar-month-outline": mdiCalendarMonthOutline, "mdi:cellphone": mdiCellphone, "mdi:cash-multiple": mdiCashMultiple, "mdi:chart-pie": mdiChartPie, "mdi:check": mdiCheck, "mdi:piggy-bank-outline": mdiPiggyBankOutline, "mdi:stairs-down": mdiStairsDown, "mdi:history": mdiHistory, "mdi:message-text-outline": mdiMessageTextOutline, "mdi:help-circle-outline": mdiHelpCircleOutline, "mdi:calendar-remove-outline": mdiCalendarRemoveOutline, "mdi:clock-outline": mdiClockOutline, "mdi:shield-check-outline": mdiShieldCheckOutline, "mdi:gift-outline": mdiGiftOutline, "mdi:google": mdiGoogle,
  "mdi:bank-transfer-out": mdiBankTransferOut, "mdi:baby-face-outline": mdiBabyFaceOutline, "mdi:school-outline": mdiSchoolOutline, "mdi:chart-line": mdiChartLine,
  "mdi:content-copy": mdiContentCopy, "mdi:file-key-outline": mdiFileKeyOutline, "mdi:key-outline": mdiKeyOutline, "mdi:account-outline": mdiAccountOutline,
  "mdi:arrow-right": mdiArrowRight, "mdi:tray-arrow-up": mdiTrayArrowUp, "mdi:timer-outline": mdiTimerOutline, "mdi:lock-outline": mdiLockOutline,
  "mdi:logout": mdiLogout, "mdi:account-plus-outline": mdiAccountPlusOutline, "mdi:account-check-outline": mdiAccountCheckOutline,
  "mdi:account-off-outline": mdiAccountOffOutline, "mdi:account-group-outline": mdiAccountGroupOutline, "mdi:tune-variant": mdiTuneVariant,
};

export function Icon({ icon, className }: { icon: string; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[icon] ?? mdiDotsHorizontal} />
    </svg>
  );
}

export function Card(props: { className?: string; children: ReactNode }) {
  return <section className={`card ${props.className ?? ""}`}>{props.children}</section>;
}

export function CardHeader(props: { icon: string; title: string; aside?: ReactNode }) {
  return (
    <div className="card-h">
      <h2><Icon icon={props.icon} />{props.title}</h2>
      {props.aside}
    </div>
  );
}

/** Bar that stops at the limit while you're under it, and runs past a marked limit when you're over. */
export function Meter({ spent, limit, label = "limit", moreIsBetter = false }: { spent: number; limit: number; label?: string; moreIsBetter?: boolean }) {
  const top = Math.max(spent, limit, 1);
  const lim = (limit / top) * 100;
  // For savings, passing the line is the goal: show it as done, not as overspending.
  const isOver = spent > limit && !moreIsBetter;
  return (
    <div className={`meter ${isOver ? "is-over" : ""}`} role="img"
      aria-label={isOver ? `${euroRound(spent)} spent, ${euroRound(spent - limit)} past the ${euroRound(limit)} limit` : `${euroRound(spent)} of ${euroRound(limit)} spent`}>
      <div className="track">
        <i className="ok" style={{ width: `${(Math.min(spent, limit) / top) * 100}%` }} />
        {isOver && <i className="over" style={{ width: `${((spent - limit) / top) * 100}%` }} />}
        {moreIsBetter && spent > limit && <i className="ok" style={{ width: `${((spent - limit) / top) * 100}%` }} />}
      </div>
      <span className={`limit ${lim > 85 ? "at-end" : lim < 15 ? "at-start" : ""}`} style={{ left: `${lim}%` }}><em className="num">{label} {euroRound(limit)}</em></span>
    </div>
  );
}


/** Where you are in Spending's drill-down: Spending › Delivery › Wolt. The last item is the current level. */
export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="crumb">
          {i > 0 && <Icon icon="mdi:chevron-right" />}
          {it.href ? <a href={it.href}>{it.label}</a> : <span aria-current="page">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** The app's one select: native list (so phones get their own picker), our look and chevron.
 * variant: "md" (40px, toolbars), "sm" (28px, inside rows), "chip" (36px, among chips). */
export function Select({ variant = "md", className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { variant?: "md" | "sm" | "chip" }) {
  return (
    <span className={`sel sel-${variant} ${className ?? ""}`}>
      <select {...props}>{children}</select>
      <Icon icon="mdi:chevron-down" />
    </span>
  );
}

/** An error from the API. Over the AI allowance (or with no key to use), a pointer to Settings → AI instead of red text. */
export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  if (!isAllowanceError(error) && !isAllowanceError(message)) return <div className="error">{message}</div>;
  return (
    <div className="notice warn allowance" role="alert">
      <Icon icon="mdi:creation-outline" />
      <div>
        <b>The assistant is paused</b>
        <p className="muted">{message}</p>
        <a className="chip" href="#/settings/section=ai">Open AI settings<Icon icon="mdi:chevron-right" /></a>
      </div>
    </div>
  );
}
