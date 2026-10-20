/**
 * Turns raw bank rows into a merchant name and a spending category.
 *
 * Alpha Bank card rows carry no merchant name, only a merchant category code (MCC) and "Αγορά"; debit card rows
 * on current accounts carry the merchant name, often typed with Greek capitals that look like Latin ones
 * ("WΟLΤ"). Transfers between your own accounts and credit card repayments are kept out of spending so nothing
 * counts twice.
 */

// Bumped whenever the rules below change, so everyone's stored history is sorted again (jobs/sync).
export const VERSION = 2;

/** id: [label, mdi icon, counts as spending] */
export const CATEGORIES: Record<string, [string, string, boolean]> = {
  groceries: ["Groceries", "mdi:cart-outline", true],
  eating_out: ["Eating out", "mdi:silverware-fork-knife", true],
  delivery: ["Delivery", "mdi:moped-outline", true],
  coffee_bars: ["Coffee & bars", "mdi:coffee-outline", true],
  car: ["Car & transport", "mdi:car-outline", true],
  subscriptions: ["Subscriptions & tech", "mdi:laptop", true],
  shopping: ["Shopping", "mdi:shopping-outline", true],
  bills: ["Bills", "mdi:file-document-outline", true],
  housing: ["Rent & home", "mdi:home-outline", true],
  loans: ["Loans & mortgage", "mdi:bank-transfer-out", true],
  insurance: ["Insurance", "mdi:shield-check-outline", true],
  health: ["Health & fitness", "mdi:heart-pulse", true],
  personal_care: ["Personal care", "mdi:content-cut", true],
  travel: ["Travel", "mdi:airplane", true],
  leisure: ["Leisure", "mdi:ticket-outline", true],
  pets: ["Pets", "mdi:paw-outline", true],
  kids: ["Kids", "mdi:baby-face-outline", true],
  education: ["Education", "mdi:school-outline", true],
  gifts: ["Gifts & donations", "mdi:gift-outline", true],
  people: ["Sent to people", "mdi:account-arrow-right-outline", true],
  cash: ["Cash", "mdi:cash", true],
  fees: ["Fees & taxes", "mdi:bank-outline", true],
  other: ["Other", "mdi:dots-horizontal", true],
  income: ["Income", "mdi:arrow-down-circle-outline", false],
  transfer: ["Own transfers", "mdi:swap-horizontal", false],
  investments: ["Investments", "mdi:chart-line", false],
  card_payment: ["Card repayments", "mdi:credit-card-check-outline", false],
};
export const SPENDING = new Set(Object.entries(CATEGORIES).filter(([, [, , spend]]) => spend).map(([k]) => k));

const LOOKALIKE: Record<string, string> = Object.fromEntries([..."ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ"].map((c, i) => [c, "ABEZHIKMNOPTYX"[i]]));
const GREEK_ONLY = new Set("ΓΔΘΛΞΠΣΦΨΩ");

const translate = (s: string) => [...s].map((c) => LOOKALIKE[c] ?? c).join("");
/** Python's " ".join(s.split()). */
export const squash = (s: string) => s.split(/\s+/u).filter(Boolean).join(" ");
const key = (text: string) => translate(squash(text.toUpperCase()));
const keys = (...words: string[]) => words.map(key);

const isCased = (c: string) => c.toUpperCase() !== c.toLowerCase();
/** Python's str.title(): a letter after anything that isn't a letter starts a word. */
export function pyTitle(s: string): string {
  let out = "", prevCased = false;
  for (const c of s) {
    out += prevCased ? c.toLowerCase() : c.toUpperCase();
    prevCased = isCased(c);
  }
  return out;
}

/** Readable merchant: Latin text written in Greek look-alikes becomes Latin, title-cased. */
export function merchantName(description: string): string {
  let text = squash(description);
  if (!text) return "";
  if (![...text.toUpperCase()].some((c) => GREEK_ONLY.has(c))) {
    text = translate(text);
    text = text.replace(/^PAYPAL \*/, "");
    text = text.replace(/\*+[\d*]*$/u, "").replace(/^[ *]+|[ *]+$/g, "");
    text = pyTitle(text.replaceAll("_", " "));
  }
  return text;
}

const DESCRIPTION_RULES: [string[], string][] = [
  [keys("ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ", "ΠΛΗΡΩΜΗ VISA", "ΠΛΗΡΩΜΗ MASTERCARD"), "card_payment"],
  [keys("ΑWΒ", "ΕΚΔΟΣΗ ΕΝΤΟΛΗΣ", "ΠΡΟΙΟΝ ΕΝΤΟΛΗΣ", "ΑΝΤ. ΕΚΔΟΣΗΣ", "REVOLUT", "ΚΑΤΑΘΕΣΗ"), "transfer"],
  [keys("ΝΟΙΚΙ", "ΕΝΟΙΚΙΟ"), "housing"],
  [keys("ΔΟΣΗ ΔΑΝΕΙΟΥ", "ΔΟΣΗ ΣΤΕΓΑΣΤΙΚΟΥ", "ΔΟΣΗ ΚΑΤΑΝΑΛΩΤΙΚΟΥ", "LOAN INSTALMENT", "LOAN REPAYMENT", "MORTGAGE"), "loans"],
  [keys("ΑΣΦΑΛΙΣΤΡ", "SYNALLAGI ASFALISTRO", "ΑΣΦΑΛΙΣΤΙΚ"), "insurance"],
  [keys("ΕΞΟΔΑ", "ΕΤΗΣΙΑ ΣΥΝΔΡΟΜΗ", "ΦΟΡΟΣ", "ΤΟΚΟΙ ΥΠΕΡΗΜΕΡΙΑΣ"), "fees"],
  [keys("ΑΝΑΛΗΨΗ", "ΥΠΕΡΑΝΑΛΗΨΗ", "ATM "), "cash"],
  [keys("ΕΝΤΟΛΗ INSTANT", "ΕΝΤΟΛΗ ΙΝSΤΑΝΤ"), "people"],
  [keys("ΔΙΑΦΟΡΕΣ ΠΛΗΡΩΜΕΣ"), "bills"],
  [keys("SDDFTSID", "ΔΕΗ", "ΕΥΔΑΠ", "COSMOTE", "VODAFONE", "NOVA", "ΗΡΩΝ", "ZENITH"), "bills"],
  [keys("ΣΥΝΔΡΟΜΕΣ"), "subscriptions"],
];

const MERCHANT_RULES: [string[], string][] = [
  // Before delivery: its "BOX" would otherwise catch subscription names that contain it.
  [keys("NETFLIX", "SPOTIFY", "CURSOR", "OPENAI", "ANTHROPIC", "GOOGLE", "ITUNES", "APPLE.COM", "YOUTUBE",
    "DISNEY", "GITHUB", "ICLOUD", "MICROSOFT", "ADOBE", "CHATGPT", "CLAUDE", "PATREON",
    "HETZNER", "CLOUDFLARE", "VERCEL", "DIGITALOCEAN"), "subscriptions"],
  [keys("WOLT", "EFOOD", "BOX ", "DELIVERY"), "delivery"],
  [keys("AB ", "AB_", "ΑΒ_", "KRITIKOS", "LIDL", "SKLAVENITIS", "ΣΚΛΑΒΕΝΙΤΗΣ", "MASOUTIS", "MY MARKET",
    "GALAXIAS", "BAZAAR", "MARGARONIS", "FOURNOS", "ARTOPOIEIO", "SUPER MARKET", "WHOLEFDS", "WHOLE FOODS",
    "TRADER JOE", "ALBERT HEIJN", "JUMBO SUPERMARKT"), "groceries"],
  [keys("ODOS", "AUTOPARK", "PARKING", "SHELL", "REVOIL", "EKO ", "AVIN", "BP ", "AEGEAN OIL", "ELINOIL",
    "UBER", "UBR*", "FREENOW", "BEAT", "OASA", "ATHENS METRO", "MOREAS", "GEFYRA", "KTEO", "FUELS", "MOTORAID", "FEDOIL"), "car"],
  [keys("STEAM", "PLAYSTATION", "NINTENDO", "CINEMA", "VILLAGE", "NOVIBET", "GAMEHOUSE"), "leisure"],
  [keys("BINANCE", "COINBASE", "KRAKEN", "BITSTAMP", "CRYPTO.COM", "BITPANDA", "TRADE REPUBLIC", "ETORO", "DEGIRO",
    "INTERACTIVE BROKERS", "IBKR", "TRADING 212", "TRADING212", "FREEDOM24", "LIGHTYEAR", "SCALABLE CAPITAL",
    "ΜΑΚΡΟΧΡΟΝΙΟ ΑΠΟΤΑΜΙΕΥΤΙΚΟ"), "investments"],
  [keys("INTERAMERICAN", "ETHNIKI ASFALISTIKI", "ΕΘΝΙΚΗ ΑΣΦΑΛΙΣΤΙΚΗ", "ALLIANZ", "GENERALI", "NN HELLAS", "NN HELLENIC",
    "EUROLIFE", "ERGO ", "AXA ", "MINETTA", "HELLAS DIRECT", "INTERLIFE", "EUROPAIKI PISTI",
    "ΕΥΡΩΠΑΪΚΗ ΠΙΣΤΗ", "METLIFE"), "insurance"],
  [keys("UDEMY", "COURSERA", "DUOLINGO", "MASTERCLASS", "SKILLSHARE", "PLURALSIGHT", "FRONTISTIRIO",
    "ΦΡΟΝΤΙΣΤΗΡΙΟ", "UNIVERSITY", "PANEPISTIMIO", "ΠΑΝΕΠΙΣΤΗΜΙΟ", "SCHOOL", "ΣΧΟΛΕΙΟ", "ΕΚΠΑΙΔΕΥΤ",
    "ΔΙΔΑΚΤΡΑ", "BRITISH COUNCIL", "HELLENIC AMERICAN"), "education"],
  [keys("ΠΑΙΔΙΚΟΣ ΣΤΑΘΜΟΣ", "PAIDIKOS STATHMOS", "BABY", "MOTHERCARE", "PAIDIKO", "ΠΑΙΔΙΚΑ", "PRENATAL",
    "ZIPPY", "KIDS"), "kids"],
  [keys("UNICEF", "ACTIONAID", "DOCTORS WITHOUT BORDERS", "ΓΙΑΤΡΟΙ ΧΩΡΙΣ ΣΥΝΟΡΑ", "RED CROSS", "ΕΡΥΘΡΟΣ ΣΤΑΥΡΟΣ",
    "ΧΑΜΟΓΕΛΟ ΤΟΥ ΠΑΙΔΙΟΥ", "GREENPEACE", "WWF", "DONATION", "ΔΩΡΕΑ", "GOFUNDME", "FLOWERS",
    "ΑΝΘΟΠΩΛΕΙΟ", "ANTHOPOLEIO"), "gifts"],
  [keys("COSMOTE", "VODAFONE", "NOVA", "ΔΕΗ", "DEI ", "EYDAP"), "bills"],
  [keys("SKROUTZ", "AMAZON", "IKEA", "PUBLIC", "PLAISIO", "KOTSOVOLOS", "JUMBO", "ZARA", "H&M", "ATTIKA", "LEROY MERLIN",
    "ACTION STORES", "LOGITECH", "GLOBALE", "TARGET", "SHOP", "PAYPAL"), "shopping"],
  [keys("BARBER", "HAIR"), "personal_care"],
  [keys("PET ", "ANIMAL.GR"), "pets"],
  [keys("PHARM", "ΦΑΡΜΑΚ", "GYM", "FITNESS", "FITN", "CLINIC", "IATR", "SURGERY"), "health"],
  [keys("AEGEAN", "RYANAIR", "BOOKING", "AIRBNB", "HOTEL", "FERRY", "BLUE STAR", "SEAJETS", "MYTRIP"), "travel"],
  [keys("CAFE", "COFFEE", "KAFE", "FLAKE", "DOMINO", "PIZZA", "BAKERY", "BURGER"), "eating_out"],
];



export function mccCategory(mcc: number): string | null {
  for (const [lo, hi, category] of MCC_RANGES) if (lo <= mcc && mcc <= hi) return category;
  return null;
}

import { MCC_RANGES } from "./reference/mcc.js";

// Revolut pockets and currency exchanges. Word ends as Python sees them: Greek letters are word characters too.
const CURRENCY = /^(TO|EXCHANGED TO) [A-Z]{3}(?![\p{L}\p{N}_])/u;
const PERSON = /^(SENT FROM REVOLUT TO|TO|FROM) (.+)$/su;

function revolut(k: string, outgoing: boolean, ownerNames: string[]): string | null {
  if (k.startsWith("TO INVESTMENT")) return "investments";
  if (CURRENCY.test(k) || k.includes("TOP-UP") || k.includes("TOP UP")) return "transfer";
  const m = PERSON.exec(k);
  if (m) {
    const who = m[2];
    if (ownerNames.some((n) => who.includes(key(n)) || key(n).includes(who))) return "transfer";
    return outgoing ? "people" : "income";
  }
  return null;
}

/** Python's int(s) for an MCC: digits, maybe signed, maybe surrounded by spaces; anything else is no code. */
function parseCode(mcc: string | null | undefined): number {
  if (mcc == null || mcc === "") return -1;
  return /^\s*[+-]?\d+\s*$/.test(String(mcc)) ? parseInt(String(mcc), 10) : -1;
}

/** ownerNames: your own names as banks print them (Settings), so transfers to yourself aren't spending. */
export function categorize(description: string, mcc: string | null | undefined, outgoing: boolean, isCard: boolean,
                           ownerNames: string[] = []): string {
  const k = key(description);
  const fromRevolut = revolut(k, outgoing, ownerNames);
  if (fromRevolut) return fromRevolut;
  for (const [words, category] of DESCRIPTION_RULES) {
    if (words.some((w) => k.startsWith(w) || ` ${k}`.includes(` ${w}`))) return category;
  }
  if (k.startsWith(key("IRIS"))) return outgoing ? "people" : "income";
  if (!outgoing && !isCard) return "income";
  for (const [words, category] of MERCHANT_RULES) {
    if (words.some((w) => k.includes(w))) return category;
  }
  const code = parseCode(mcc);
  const byCode = code > 0 ? mccCategory(code) : null;
  return byCode || "other";
}
