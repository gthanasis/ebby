"""Sorting the payments the app couldn't place, one at a time.

Banks send no time or place, so each payment comes with what can be told about it: when it was,
the type of shop the bank files it under, what else was paid that day, and earlier payments to the
same payee. Claude reads that and makes a guess with a reason; the guess is kept per payee, so it's
made once. Answering moves every payment to that payee, now and later.
"""

import logging
from datetime import date, datetime, timezone

import anthropic
from pydantic import BaseModel, Field

from . import ai, ai_usage, config, db, insights, spending
from .categories import CATEGORIES

log = logging.getLogger("bank-sync")

# What the bank's merchant category code means, in plain words. Common codes only; the rest show nothing.
SHOP_TYPES = {
    "4111": "local transport", "4121": "taxis and ride hailing", "4131": "bus lines", "4411": "cruise lines", "4511": "airlines",
    "4722": "travel agencies", "4784": "road tolls", "4789": "transport services", "4812": "phone shops", "4814": "phone and mobile services",
    "4816": "online services", "4829": "money transfers", "4899": "TV and streaming services", "4900": "utilities",
    "5045": "computers and electronics", "5094": "jewellery and watches", "5111": "stationery", "5137": "uniforms and clothing",
    "5200": "home supply stores", "5211": "building materials", "5251": "hardware stores", "5261": "garden centres",
    "5300": "wholesale clubs", "5309": "duty-free shops", "5310": "discount stores", "5311": "department stores",
    "5331": "variety stores", "5399": "general merchandise", "5411": "supermarkets", "5422": "butchers", "5441": "sweet shops",
    "5451": "dairy shops", "5462": "bakeries", "5499": "food shops", "5511": "car dealers", "5532": "tyre shops", "5533": "car parts",
    "5541": "petrol stations", "5542": "petrol stations", "5611": "menswear", "5621": "womenswear", "5631": "accessories",
    "5641": "children's clothing", "5651": "clothing", "5655": "sportswear", "5661": "shoe shops", "5691": "clothing",
    "5699": "clothing and accessories", "5712": "furniture", "5719": "home furnishings", "5722": "household appliances",
    "5732": "electronics", "5734": "software", "5735": "music shops", "5811": "caterers", "5812": "restaurants", "5813": "bars",
    "5814": "fast food", "5815": "digital media", "5816": "games", "5817": "apps", "5818": "digital goods", "5912": "pharmacies",
    "5921": "off-licences", "5932": "antique shops", "5941": "sporting goods", "5942": "bookshops", "5943": "stationery",
    "5945": "toy and game shops", "5947": "gift shops", "5948": "leather goods", "5970": "art supplies", "5977": "cosmetics",
    "5992": "florists", "5993": "tobacconists", "5994": "newsagents", "5995": "pet shops", "5999": "shops", "6010": "bank counters",
    "6011": "cash machines", "6012": "financial services", "6300": "insurance", "7011": "hotels", "7210": "laundries",
    "7216": "dry cleaners", "7230": "hairdressers and beauty", "7251": "shoe repair and key cutting", "7298": "spas and massage",
    "7299": "personal services", "7311": "advertising", "7372": "software and IT services", "7399": "business services",
    "7512": "car rental", "7523": "parking", "7531": "car body repair", "7538": "car servicing", "7542": "car washes",
    "7832": "cinemas", "7841": "video and games rental", "7911": "dance studios", "7922": "theatre and concert tickets",
    "7929": "bands and entertainers", "7932": "billiards", "7933": "bowling alleys", "7941": "sports clubs",
    "7991": "tourist attractions", "7992": "golf", "7994": "arcades", "7996": "amusement parks", "7997": "gyms and clubs",
    "7999": "recreation", "8011": "doctors", "8021": "dentists", "8042": "opticians", "8043": "opticians", "8062": "hospitals",
    "8071": "medical labs", "8099": "health services", "8211": "schools", "8220": "universities", "8299": "courses and lessons",
    "8398": "charities", "8641": "associations", "8999": "professional services", "9211": "court costs", "9222": "fines",
    "9311": "taxes", "9399": "government services", "9402": "postal services",
}
GUESS_KEY = "sorter_guesses"


def _how(row) -> str:
    bank = row["bank"]
    if row["is_card"]:
        return f"{bank} card"
    if row["mcc"]:  # a shop type means a card purchase, even when it's booked on the current account
        return f"{bank} debit card"
    if (row["description"] or "").startswith("ΕΝΤ"):
        return f"{bank} payment order"
    return f"{bank} transfer" if bank == "Revolut" else f"{bank} payment"


def items(conn) -> list[dict]:
    """Every payee waiting in Other, each with what can be told about its latest payment."""
    out = []
    guesses = db.get_meta(conn, GUESS_KEY) or {}
    today = insights.local_today()
    for q in insights.questions(conn, limit=50):
        t = conn.execute("""SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.name AS account_name, a.bank, a.is_card
                            FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.id = ?""", (q["tx_id"],)).fetchone()
        if not t:
            continue
        d = date.fromisoformat(t["date"])
        same_day = [{"name": r["name"], "amount": r["amount"], "category": r["category"]}
                    for r in spending._rows(conn, d, d) if r["name"] != q["service"]]
        history = [{"date": r["date"], "amount": round(-r["amount"], 2)} for r in conn.execute(
            """SELECT date, amount FROM transactions WHERE (merchant = ? OR description = ?) AND amount < 0 AND duplicate_of IS NULL
               AND id != ? ORDER BY date DESC LIMIT 6""", (t["merchant"], t["description"], t["id"]))]
        out.append({
            "service": q["service"], "tx_id": t["id"], "date": t["date"], "days_ago": (today - d).days,
            "amount": round(-t["amount"], 2), "count": q["count"], "total": q["amount"],
            "how": _how(t), "shop": SHOP_TYPES.get(str(t["mcc"] or "")), "description": t["description"],
            "same_day": same_day[:6], "history": history, "guess": guesses.get(q["service"]),
        })
    return out


class Guess(BaseModel):
    category: str = Field(description="One category id from the list")
    reason: str = Field(description="Why, in one or two short sentences that name the clues used, e.g. the shop type or the day's other payments")


GUESS_SYSTEM = """You help one person sort a bank payment the app couldn't categorise. Banks send no time or place,
so use what's given: the shop type the bank files it under, the payee's name, the amount, what else was paid
that day, and earlier payments to the same payee. Pick the most likely category and say why in one or two short
sentences, naming the clues. Be plain and specific; if it's genuinely unclear, say what makes it unclear and
still pick the likeliest. Greek and other payee names may be transliterated or abbreviated."""


def _context(item: dict) -> str:
    lines = [f"Payment: €{item['amount']:.2f} to \"{item['service']}\" (bank text: \"{item['description']}\") on {item['date']}, "
             f"{item['days_ago']} days ago, a {datetime.fromisoformat(item['date']).strftime('%A')}, by {item['how']}."]
    if item["count"] > 1:
        lines.append(f"There are {item['count']} such payments in the last 90 days, €{item['total']:.2f} in all.")
    lines.append(f"Shop type from the bank: {item['shop'] or 'none given'}.")
    lines.append("Other payments that day: " + ("; ".join(f"{p['name']} €{p['amount']:.2f} ({p['category']})" for p in item["same_day"]) or "none") + ".")
    lines.append("Earlier payments to this payee: " + ("; ".join(f"{h['date']} €{h['amount']:.2f}" for h in item["history"]) or "none") + ".")
    lines.append("Categories (id: name): " + "; ".join(f"{k}: {v[0]}" for k, v in CATEGORIES.items()))
    return "\n".join(lines)


def guess(conn, service: str) -> dict | None:
    """Claude's guess for a payee, made once and kept."""
    guesses = db.get_meta(conn, GUESS_KEY) or {}
    if service in guesses:
        return guesses[service]
    item = next((i for i in items(conn) if i["service"] == service), None)
    if not item or not ai.available():
        return None
    try:
        claude = ai.client("sorter")
    except (ai_usage.BudgetExceeded, ai_usage.NoAPIKey) as e:
        log.info("sorter guess skipped: %s", e)
        return None
    model = ai.assistant_model(conn)
    try:
        response = claude.client.beta.messages.parse(
            model=model, max_tokens=2000, output_config={"effort": "low"}, system=GUESS_SYSTEM,
            messages=[{"role": "user", "content": _context(item)}], output_format=Guess, **ai.fallback(model),
        )
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log.warning("sorter guess failed: %s", getattr(e, "message", e))
        return None
    ai.record(claude, model, response.usage)
    g = response.parsed_output
    if response.stop_reason == "refusal" or g is None or g.category not in CATEGORIES:
        return None
    result = {"category": g.category, "reason": g.reason, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    guesses[service] = result
    db.set_meta(conn, GUESS_KEY, guesses)
    return result

