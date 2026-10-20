"""Turns raw bank rows into a merchant name and a spending category.

Alpha Bank card rows carry no merchant name, only a merchant category code (MCC) and
"Αγορά"; debit card rows on current accounts carry the merchant name, often typed
with Greek capitals that look like Latin ones ("WΟLΤ"). Transfers between your own
accounts and credit card repayments are kept out of spending so nothing counts twice.
"""

import re

# Bumped whenever the rules below change, so everyone's stored history is sorted again (sync.run_scheduler).
VERSION = 2

# id: (label, mdi icon, counts as spending)
CATEGORIES = {
    "groceries": ("Groceries", "mdi:cart-outline", True),
    "eating_out": ("Eating out", "mdi:silverware-fork-knife", True),
    "delivery": ("Delivery", "mdi:moped-outline", True),
    "coffee_bars": ("Coffee & bars", "mdi:coffee-outline", True),
    "car": ("Car & transport", "mdi:car-outline", True),
    "subscriptions": ("Subscriptions & tech", "mdi:laptop", True),
    "shopping": ("Shopping", "mdi:shopping-outline", True),
    "bills": ("Bills", "mdi:file-document-outline", True),
    "housing": ("Rent & home", "mdi:home-outline", True),
    "loans": ("Loans & mortgage", "mdi:bank-transfer-out", True),
    "insurance": ("Insurance", "mdi:shield-check-outline", True),
    "health": ("Health & fitness", "mdi:heart-pulse", True),
    "personal_care": ("Personal care", "mdi:content-cut", True),
    "travel": ("Travel", "mdi:airplane", True),
    "leisure": ("Leisure", "mdi:ticket-outline", True),
    "pets": ("Pets", "mdi:paw-outline", True),
    "kids": ("Kids", "mdi:baby-face-outline", True),
    "education": ("Education", "mdi:school-outline", True),
    "gifts": ("Gifts & donations", "mdi:gift-outline", True),
    "people": ("Sent to people", "mdi:account-arrow-right-outline", True),
    "cash": ("Cash", "mdi:cash", True),
    "fees": ("Fees & taxes", "mdi:bank-outline", True),
    "other": ("Other", "mdi:dots-horizontal", True),
    "income": ("Income", "mdi:arrow-down-circle-outline", False),
    "transfer": ("Own transfers", "mdi:swap-horizontal", False),
    "investments": ("Investments", "mdi:chart-line", False),
    "card_payment": ("Card repayments", "mdi:credit-card-check-outline", False),
}
SPENDING = {k for k, (_, _, spend) in CATEGORIES.items() if spend}

_LOOKALIKE = str.maketrans("ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", "ABEZHIKMNOPTYX")
_GREEK_ONLY = set("ΓΔΘΛΞΠΣΦΨΩ")


def _key(text: str) -> str:
    return " ".join(text.upper().split()).translate(_LOOKALIKE)


def _keys(*words: str) -> tuple:
    return tuple(_key(w) for w in words)


def merchant_name(description: str) -> str:
    """Readable merchant: Latin text written in Greek look-alikes becomes Latin, title-cased."""
    text = " ".join(description.split())
    if not text:
        return ""
    if not set(text.upper()) & _GREEK_ONLY:
        text = text.translate(_LOOKALIKE)
        text = re.sub(r"^PAYPAL \*", "", text)
        text = re.sub(r"\*+[\d*]*$", "", text).strip(" *")
        text = text.replace("_", " ").title()
    return text


DESCRIPTION_RULES = [
    (_keys("ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ", "ΠΛΗΡΩΜΗ VISA", "ΠΛΗΡΩΜΗ MASTERCARD"), "card_payment"),
    (_keys("ΑWΒ", "ΕΚΔΟΣΗ ΕΝΤΟΛΗΣ", "ΠΡΟΙΟΝ ΕΝΤΟΛΗΣ", "ΑΝΤ. ΕΚΔΟΣΗΣ", "REVOLUT", "ΚΑΤΑΘΕΣΗ"), "transfer"),
    (_keys("ΝΟΙΚΙ", "ΕΝΟΙΚΙΟ"), "housing"),
    (_keys("ΔΟΣΗ ΔΑΝΕΙΟΥ", "ΔΟΣΗ ΣΤΕΓΑΣΤΙΚΟΥ", "ΔΟΣΗ ΚΑΤΑΝΑΛΩΤΙΚΟΥ", "LOAN INSTALMENT", "LOAN REPAYMENT",
           "MORTGAGE"), "loans"),
    (_keys("ΑΣΦΑΛΙΣΤΡ", "SYNALLAGI ASFALISTRO", "ΑΣΦΑΛΙΣΤΙΚ"), "insurance"),
    (_keys("ΕΞΟΔΑ", "ΕΤΗΣΙΑ ΣΥΝΔΡΟΜΗ", "ΦΟΡΟΣ", "ΤΟΚΟΙ ΥΠΕΡΗΜΕΡΙΑΣ"), "fees"),
    (_keys("ΑΝΑΛΗΨΗ", "ΥΠΕΡΑΝΑΛΗΨΗ", "ATM "), "cash"),
    (_keys("ΕΝΤΟΛΗ INSTANT", "ΕΝΤΟΛΗ ΙΝSΤΑΝΤ"), "people"),
    (_keys("ΔΙΑΦΟΡΕΣ ΠΛΗΡΩΜΕΣ"), "bills"),
    (_keys("SDDFTSID", "ΔΕΗ", "ΕΥΔΑΠ", "COSMOTE", "VODAFONE", "NOVA", "ΗΡΩΝ", "ZENITH"), "bills"),
    (_keys("ΣΥΝΔΡΟΜΕΣ"), "subscriptions"),
]

MERCHANT_RULES = [
    # Before delivery: its "BOX" would otherwise catch subscription names that contain it.
    (_keys("NETFLIX", "SPOTIFY", "CURSOR", "OPENAI", "ANTHROPIC", "GOOGLE", "ITUNES", "APPLE.COM", "YOUTUBE",
           "DISNEY", "GITHUB", "ICLOUD", "MICROSOFT", "ADOBE", "CHATGPT", "CLAUDE", "PATREON",
           "HETZNER", "CLOUDFLARE", "VERCEL", "DIGITALOCEAN"), "subscriptions"),
    (_keys("WOLT", "EFOOD", "BOX ", "DELIVERY"), "delivery"),
    (_keys("AB ", "AB_", "ΑΒ_", "KRITIKOS", "LIDL", "SKLAVENITIS", "ΣΚΛΑΒΕΝΙΤΗΣ", "MASOUTIS", "MY MARKET",
           "GALAXIAS", "BAZAAR", "MARGARONIS", "FOURNOS", "ARTOPOIEIO", "SUPER MARKET", "WHOLEFDS", "WHOLE FOODS",
           "TRADER JOE", "ALBERT HEIJN", "JUMBO SUPERMARKT"), "groceries"),
    (_keys("ODOS", "AUTOPARK", "PARKING", "SHELL", "REVOIL", "EKO ", "AVIN", "BP ", "AEGEAN OIL", "ELINOIL",
           "UBER", "UBR*", "FREENOW", "BEAT", "OASA", "ATHENS METRO", "MOREAS", "GEFYRA", "KTEO", "FUELS", "MOTORAID", "FEDOIL"), "car"),
    (_keys("STEAM", "PLAYSTATION", "NINTENDO", "CINEMA", "VILLAGE", "NOVIBET", "GAMEHOUSE"), "leisure"),
    (_keys("BINANCE", "COINBASE", "KRAKEN", "BITSTAMP", "CRYPTO.COM", "BITPANDA", "TRADE REPUBLIC", "ETORO", "DEGIRO",
           "INTERACTIVE BROKERS", "IBKR", "TRADING 212", "TRADING212", "FREEDOM24", "LIGHTYEAR", "SCALABLE CAPITAL",
           "ΜΑΚΡΟΧΡΟΝΙΟ ΑΠΟΤΑΜΙΕΥΤΙΚΟ"), "investments"),
    (_keys("INTERAMERICAN", "ETHNIKI ASFALISTIKI", "ΕΘΝΙΚΗ ΑΣΦΑΛΙΣΤΙΚΗ", "ALLIANZ", "GENERALI", "NN HELLAS", "NN HELLENIC",
           "EUROLIFE", "ERGO ", "AXA ", "MINETTA", "HELLAS DIRECT", "INTERLIFE", "EUROPAIKI PISTI",
           "ΕΥΡΩΠΑΪΚΗ ΠΙΣΤΗ", "METLIFE"), "insurance"),
    (_keys("UDEMY", "COURSERA", "DUOLINGO", "MASTERCLASS", "SKILLSHARE", "PLURALSIGHT", "FRONTISTIRIO",
           "ΦΡΟΝΤΙΣΤΗΡΙΟ", "UNIVERSITY", "PANEPISTIMIO", "ΠΑΝΕΠΙΣΤΗΜΙΟ", "SCHOOL", "ΣΧΟΛΕΙΟ", "ΕΚΠΑΙΔΕΥΤ",
           "ΔΙΔΑΚΤΡΑ", "BRITISH COUNCIL", "HELLENIC AMERICAN"), "education"),
    (_keys("ΠΑΙΔΙΚΟΣ ΣΤΑΘΜΟΣ", "PAIDIKOS STATHMOS", "BABY", "MOTHERCARE", "PAIDIKO", "ΠΑΙΔΙΚΑ", "PRENATAL",
           "ZIPPY", "KIDS"), "kids"),
    (_keys("UNICEF", "ACTIONAID", "DOCTORS WITHOUT BORDERS", "ΓΙΑΤΡΟΙ ΧΩΡΙΣ ΣΥΝΟΡΑ", "RED CROSS", "ΕΡΥΘΡΟΣ ΣΤΑΥΡΟΣ",
           "ΧΑΜΟΓΕΛΟ ΤΟΥ ΠΑΙΔΙΟΥ", "GREENPEACE", "WWF", "DONATION", "ΔΩΡΕΑ", "GOFUNDME", "FLOWERS",
           "ΑΝΘΟΠΩΛΕΙΟ", "ANTHOPOLEIO"), "gifts"),
    (_keys("COSMOTE", "VODAFONE", "NOVA", "ΔΕΗ", "DEI ", "EYDAP"), "bills"),
    (_keys("SKROUTZ", "AMAZON", "IKEA", "PUBLIC", "PLAISIO", "KOTSOVOLOS", "JUMBO", "ZARA", "H&M", "ATTIKA", "LEROY MERLIN",
           "ACTION STORES", "LOGITECH", "GLOBALE", "TARGET", "SHOP", "PAYPAL"), "shopping"),
    (_keys("BARBER", "HAIR"), "personal_care"),
    (_keys("PET ", "ANIMAL.GR"), "pets"),
    (_keys("PHARM", "ΦΑΡΜΑΚ", "GYM", "FITNESS", "FITN", "CLINIC", "IATR", "SURGERY"), "health"),
    (_keys("AEGEAN", "RYANAIR", "BOOKING", "AIRBNB", "HOTEL", "FERRY", "BLUE STAR", "SEAJETS", "MYTRIP"), "travel"),
    (_keys("CAFE", "COFFEE", "KAFE", "FLAKE", "DOMINO", "PIZZA", "BAKERY", "BURGER"), "eating_out"),
]


def _mcc_category(mcc: int) -> str | None:
    ranges = [
        ((5411, 5411), "groceries"), ((5422, 5462), "groceries"), ((5499, 5499), "groceries"),
        ((5811, 5812), "eating_out"), ((5814, 5814), "eating_out"),
        ((5813, 5813), "coffee_bars"),
        ((4784, 4784), "car"), ((5541, 5542), "car"), ((5983, 5983), "car"), ((7523, 7523), "car"),
        ((7531, 7549), "car"), ((5511, 5599), "car"), ((4111, 4131), "car"), ((4789, 4789), "car"),
        ((4121, 4121), "car"),
        ((4816, 4816), "subscriptions"), ((5045, 5045), "subscriptions"), ((5732, 5734), "subscriptions"),
        ((5815, 5818), "subscriptions"), ((7372, 7372), "subscriptions"), ((4899, 4899), "subscriptions"),
        ((4812, 4814), "bills"), ((4900, 4900), "bills"),
        ((5912, 5912), "health"), ((8011, 8099), "health"), ((7997, 7997), "health"), ((7941, 7941), "health"),
        ((7230, 7230), "personal_care"), ((7298, 7298), "personal_care"), ((5977, 5977), "personal_care"),
        ((3000, 3299), "travel"), ((3501, 3999), "travel"), ((4411, 4411), "travel"), ((4511, 4511), "travel"),
        ((4722, 4722), "travel"), ((7011, 7011), "travel"), ((4112, 4112), "travel"),
        ((7832, 7832), "leisure"), ((7922, 7922), "leisure"), ((7991, 7996), "leisure"), ((7999, 7999), "leisure"),
        ((5995, 5995), "pets"), ((742, 742), "pets"),
        ((6010, 6011), "cash"),
        ((4829, 4829), "people"),
        ((9311, 9399), "fees"), ((6012, 6012), "transfer"), ((6300, 6399), "insurance"), ((4214, 4215), "shopping"),
        ((6211, 6211), "investments"), ((6051, 6051), "investments"),
        ((8211, 8299), "education"), ((5942, 5943), "education"),
        ((8351, 8351), "kids"), ((5641, 5641), "kids"),
        ((8398, 8398), "gifts"), ((8661, 8661), "gifts"), ((5992, 5992), "gifts"), ((5947, 5947), "gifts"),
        ((5200, 5399), "shopping"), ((5600, 5735), "shopping"), ((5900, 5999), "shopping"), ((5094, 5094), "shopping"),
    ]
    for (lo, hi), category in ranges:
        if lo <= mcc <= hi:
            return category
    return None


_CURRENCY = re.compile(r"^(TO|EXCHANGED TO) [A-Z]{3}\b")  # Revolut pockets and currency exchanges
_PERSON = re.compile(r"^(SENT FROM REVOLUT TO|TO|FROM) (.+)$")


def _revolut(key: str, outgoing: bool, owner_names) -> str | None:
    if key.startswith("TO INVESTMENT"):
        return "investments"
    if _CURRENCY.match(key) or "TOP-UP" in key or "TOP UP" in key:
        return "transfer"
    if m := _PERSON.match(key):
        who = m.group(2)
        if any(_key(n) in who or who in _key(n) for n in owner_names):
            return "transfer"
        return "people" if outgoing else "income"
    return None


def categorize(description: str, mcc: str | None, outgoing: bool, is_card: bool, owner_names=()) -> str:
    """owner_names: your own names as banks print them (Settings), so transfers to yourself aren't spending."""
    key = _key(description)
    if category := _revolut(key, outgoing, owner_names):
        return category
    for words, category in DESCRIPTION_RULES:
        if any(key.startswith(w) or f" {w}" in f" {key}" for w in words):
            return category
    if key.startswith(_key("IRIS")):
        return "people" if outgoing else "income"
    if not outgoing and not is_card:
        return "income"
    for words, category in MERCHANT_RULES:
        if any(w in key for w in words):
            return category
    try:
        code = int(mcc) if mcc not in (None, "") else -1
    except ValueError:
        code = -1
    if code > 0 and (category := _mcc_category(code)):
        return category
    return "other"
