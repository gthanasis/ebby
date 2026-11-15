/** The app as the person sees it, and the API route behind each screen: the assistant reads these routes with
 * read_app (the same numbers the screen shows) and changes things with propose_change. Months are pay months,
 * YYYY-MM; leave month out for the current one. */

export const APP_MAP = `The app, screen by screen, and the route behind each (read with read_app):

Overview tab (home): this pay month's money used and left, the per-day amount to live by, the savings goal, fixed
costs paid and due. GET /api/home. The pace behind it: GET /api/pace?month=.
Spending tab (Highlights, Categories, Payments, Fixed): GET /api/spending?range=day|week|month|year&off=0|-1|-2…
(off counts back). One category: GET /api/spending/category?category=&range=&off= and GET /api/category/{id}?month=.
One payee (a "service") in a category: GET /api/service?category=&name=&month=. The Fixed tab: GET /api/fixed?month=
(each fixed cost this month, paid or due, with its payments). A year: GET /api/year?year=YYYY. Month totals and the
month before: GET /api/overview?month=.
Subscriptions: GET /api/subscriptions. All payments: GET /api/transactions?month=&category=&account=&q=&service=
&commitment={fixed cost id}&limit=&offset= (full payment ids). One payment's sheet: GET /api/payment?id={full id}.
What each month kept against the savings goal: GET /api/kept?months=N.
Goals tab: savings goals, saving every month, things to buy: GET /api/goals/overview and GET /api/goals. Habits
(spending rules and this week): GET /api/habits, GET /api/habits/weekly, one habit: GET /api/habits/rules/{id}.
Sorting payments (open questions): GET /api/sorter.
Settings tab (the person's profile and settings): Monthly income, savings and category budgets: GET /api/plan.
Payday and other settings: GET /api/me. Fixed costs (Settings → Fixed costs, where they are added, changed and
removed): GET /api/commitments?month= (each with id, limit, how often, amount, next date, payees it matches, history);
payees to pick from: GET /api/commitments/services. What the assistant remembers (Settings → Assistant): GET
/api/assistant/memory. Banks and sync status: GET /api/status. Category ids and names: GET /api/categories.

Changes (propose_change; call describe_change first for the exact body):
Fixed costs: POST /api/commitments, PUT /api/commitments/{id} (send the whole cost back, changed), DELETE
/api/commitments/{id}. Link one payment to a fixed cost, or null to mark it as spending: PUT /api/payment/commitment.
One payment's category: PUT /api/transactions/{full id, URL-encoded}/category; a payee's name: PUT
/api/transactions/{id}/payee. A whole payee to another category: POST /api/service/move. Answer a sorting question:
POST /api/assistant/answer; undo one: POST /api/sorter/undo.
Plan: PUT /api/plan (take-home, keep, budgets), PUT /api/plan/limit (one month's spending limit). Settings: PUT
/api/settings. Goals: POST /api/goals, PATCH /api/goals/{id}, DELETE /api/goals/{id}. Habits: POST /api/habits/rules,
PATCH or DELETE /api/habits/rules/{id}; which accounts are savings: PUT /api/habits/savings-accounts. Thinking-about-it
list: POST /api/wishlist, POST /api/wishlist/{id}/decide. Yearly costs: POST /api/yearly, DELETE /api/yearly/{id}.
What to remember: POST /api/assistant/memory, PUT or DELETE /api/assistant/memory/{id}.`;
