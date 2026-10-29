// What the app changes through the API, checked the way the app sees it: through the reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contractApp } from "./contract.js";

let api: Awaited<ReturnType<typeof contractApp>>;
beforeAll(async () => { api = await contractApp("ebby_ts_api_writes"); });
afterAll(() => api.teardown());

const send = (method: string, path: string, data?: unknown) =>
  api.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }), headers: { Origin: "http://localhost" } });
const first = async (path: string) => (await api.json(path)).rows[0];
const spent = async (category: string) => (await api.json("/api/overview")).by_category.find((c: any) => c.category === category)?.amount ?? 0;
const categoriesOf = async (merchant: string) =>
  new Set((await api.json(`/api/transactions?q=${encodeURIComponent(merchant)}&limit=500`)).rows.filter((t: any) => t.merchant === merchant).map((t: any) => t.category));
const services = async (category: string) => new Set((await api.json(`/api/category/${category}`)).services.map((s: any) => s.name));

describe("writes", () => {
  it("moving a payment, then its payee", async () => {
    const tx = await first("/api/transactions?q=wolt");
    const before = await spent("delivery");
    const one = await (await send("PUT", `/api/transactions/${encodeURIComponent(tx.id)}/category`, { category: "eating_out" })).json();
    expect(one.rule).toBe(`tx:${tx.id}`);
    expect(one.others).toBeGreaterThan(0);
    expect(await spent("delivery")).toBeLessThan(before);  // only that one payment moved
    const all = await (await send("PUT", `/api/transactions/${encodeURIComponent(tx.id)}/category`, { category: "eating_out", all_from_merchant: true })).json();
    expect([all.rule, all.others]).toEqual([tx.merchant, 0]);
    expect(await categoriesOf(tx.merchant)).toEqual(new Set(["eating_out"]));
  });

  it("unknown categories and payments are refused", async () => {
    const tx = await first("/api/transactions");
    expect((await send("PUT", `/api/transactions/${encodeURIComponent(tx.id)}/category`, { category: "yachts" })).status).toBe(400);
    expect((await send("PUT", "/api/transactions/no-such-id/category", { category: "groceries" })).status).toBe(404);
  });

  it("a payee answered in the sorter can be taken back", async () => {
    const service = [...await services("groceries")].sort()[0] as string;
    expect((await send("POST", "/api/assistant/answer", { service, category: "shopping" })).status).toBe(200);
    expect((await services("groceries")).has(service)).toBe(false);
    expect((await services("shopping")).has(service)).toBe(true);
    expect((await (await send("POST", "/api/sorter/undo", { service })).json()).moved).toBeGreaterThan(0);
    expect((await services("groceries")).has(service)).toBe(true);
  });

  it("goals are added, changed and removed", async () => {
    const count = (await api.json("/api/goals")).length;
    expect((await send("POST", "/api/goals", { name: "Bike", price: 600, target_date: "2026-09-01" })).status).toBe(400);  // past
    const goals = await (await send("POST", "/api/goals", { name: "Bike", price: 600, target_date: "2027-04-01", saved: 50 })).json();
    expect(goals.length).toBe(count + 1);
    const bike = goals.find((g: any) => g.name === "Bike");
    expect((await send("PATCH", `/api/goals/${bike.id}`, { add: 100 })).status).toBe(200);
    expect((await api.json("/api/goals")).find((g: any) => g.id === bike.id).saved).toBe(150);
    expect([200, 204]).toContain((await send("DELETE", `/api/goals/${bike.id}`)).status);
    expect((await api.json("/api/goals")).length).toBe(count);
  });

  it("a commitment takes its payments out of free spending", async () => {
    const tx = await first("/api/transactions?category=bills");
    const before = await spent("bills");
    expect((await send("POST", "/api/commitments", { name: "Phone and power", kind: "fixed", monthly_limit: 150, services: [tx.merchant] })).status).toBe(200);
    expect(await spent("bills")).toBeLessThan(before);
    const cid = (await api.json("/api/commitments")).items.find((c: any) => c.name === "Phone and power").id;
    expect((await send("POST", "/api/commitments", { name: "Insurance", monthly_limit: 0, every_months: 6, amount: 300 })).status).toBe(400);
    expect([200, 204]).toContain((await send("DELETE", `/api/commitments/${cid}`)).status);
    expect(await spent("bills")).toBe(before);
  });

  it("the plan, and a month's working limit that adds up to itself", async () => {
    const plan = (await api.json("/api/plan")).plan;
    expect((await send("PUT", "/api/plan", { take_home: 2600, keep: 300 })).status).toBe(200);
    expect((await api.json("/api/plan")).plan.take_home).toBe(2600);
    expect((await send("PUT", "/api/plan/limit", { month: "2026-10", limit: 1800 })).status).toBe(200);
    expect((await send("PUT", "/api/plan/limit", { month: "October", limit: 1800 })).status).toBe(422);
    expect((await api.json("/api/pace")).planned).toBe(1800);
    // Overview works from the month's own limit, and still knows what the plan alone gives.
    const ideal = (await api.json("/api/home")).month.ideal;
    expect(ideal.budget).toBe(1800);
    expect(ideal.planned).not.toBe(1800);
    await send("PUT", "/api/plan", { take_home: plan.take_home, keep: plan.keep });
  });

  it("payday decides where the pay month starts", async () => {
    expect((await api.json("/api/pace")).start).toBe("2026-09-25");  // the demo is paid on the 25th
    expect((await send("PUT", "/api/settings", { payday: 1 })).status).toBe(200);
    const pace = await api.json("/api/pace");
    expect([pace.start, pace.end]).toEqual(["2026-10-01", "2026-11-01"]);
    await send("PUT", "/api/settings", { payday: 25 });
    expect((await api.json("/api/pace")).start).toBe("2026-09-25");
  });

  it("habits, the wishlist and yearly costs", async () => {
    const rule = await send("POST", "/api/habits/rules", { type: "fewer", category: "eating_out", target: 2 });
    expect(rule.status).toBe(200);
    const hid = (await rule.json()).id;
    expect((await send("PATCH", `/api/habits/rules/${hid}`, { target: 3 })).status).toBe(200);
    expect((await api.json(`/api/habits/rules/${hid}`)).target).toBe(3);
    expect([200, 204]).toContain((await send("DELETE", `/api/habits/rules/${hid}`)).status);

    expect((await send("POST", "/api/wishlist", { name: "", price: 10 })).status).toBe(400);
    await send("POST", "/api/wishlist", { name: "Headphones", price: 180 });
    const wish = (await api.json("/api/habits")).wishlist.find((w: any) => w.name === "Headphones");
    expect(wish).toBeDefined();
    expect((await send("POST", `/api/wishlist/${wish.id}/decide`, { decision: "maybe" })).status).toBe(400);
    expect((await send("POST", `/api/wishlist/${wish.id}/decide`, { decision: "skipped" })).status).toBe(200);

    expect((await send("POST", "/api/yearly", { name: "Car tax", yearly_amount: 180, due_month: 13 })).status).toBe(400);
    expect((await send("POST", "/api/yearly", { name: "Car tax", yearly_amount: 180, due_month: 12 })).status).toBe(200);
    expect((await api.json("/api/habits")).yearly.items.some((y: any) => y.name === "Car tax")).toBe(true);
  });

  it("moving a whole service", async () => {
    const name = [...await services("groceries")].sort().at(-1) as string;
    expect((await send("POST", "/api/service/move", { category: "groceries", name, to: "shopping" })).status).toBe(200);
    expect((await services("groceries")).has(name)).toBe(false);
    expect((await services("shopping")).has(name)).toBe(true);
  });

  it("a payment linked to a fixed cost by hand leaves spending, and comes back when unlinked", async () => {
    const tx = (await api.json("/api/spending")).payments.find((p: any) => p.category === "groceries");
    const before = (await api.json("/api/spending")).total;
    const cost = await (await send("POST", "/api/commitments", { name: "Rent", kind: "fixed", monthly_limit: 500, off_bank: 0, services: ["nobody"] })).json();
    const cid = cost.items.find((c: any) => c.name === "Rent").id;
    const linked = await (await send("PUT", "/api/payment/commitment", { id: tx.id, commitment_id: cid })).json();
    expect([linked.commitment, linked.pinned]).toEqual(["Rent", true]);
    const after = await api.json("/api/spending");
    expect(after.total).toBeCloseTo(before - tx.amount, 2);
    expect(after.fixed.map((p: any) => p.id)).toContain(tx.id);
    const rent = (await api.json("/api/fixed")).items.find((c: any) => c.id === cid);
    expect([rent.status, rent.paid]).toEqual(["paid", tx.amount]);
    // Matching the payees again (any commitment saved) keeps the link.
    await send("POST", "/api/commitments", { name: "Gym two", kind: "chosen", monthly_limit: 10, services: ["nobody either"] });
    expect((await api.json(`/api/payment?id=${encodeURIComponent(tx.id)}`)).commitment).toBe("Rent");
    expect((await (await send("PUT", "/api/payment/commitment", { id: tx.id, commitment_id: null })).json()).commitment).toBeNull();
    expect((await api.json("/api/spending")).total).toBeCloseTo(before, 2);
    expect((await send("PUT", "/api/payment/commitment", { id: tx.id, commitment_id: 999999 })).status).toBe(404);
    expect((await send("PUT", "/api/payment/commitment", { id: "no-such-id", commitment_id: null })).status).toBe(404);
    for (const c of (await api.json("/api/commitments")).items.filter((c: any) => ["Rent", "Gym two"].includes(c.name))) await send("DELETE", `/api/commitments/${c.id}`);
  });

  it("what the assistant remembers is added, changed and forgotten", async () => {
    const added = await (await send("POST", "/api/assistant/memory", { text: "  Transfers to Maria are my half of the rent. ", service: null })).json();
    expect(added[0]).toMatchObject({ text: "Transfers to Maria are my half of the rent.", source: "you", used: 0 });
    const fromPayment = await (await send("POST", "/api/assistant/memory", { text: "Presents, mostly", service: "Kotsovolos" })).json();
    expect(fromPayment[0]).toMatchObject({ source: "payment", service: "Kotsovolos" });
    expect((await send("POST", "/api/assistant/memory", { text: "   " })).status).toBe(400);
    const changed = await (await send("PUT", `/api/assistant/memory/${added[0].id}`, { text: "Maria: rent" })).json();
    expect(changed.find((m: any) => m.id === added[0].id).text).toBe("Maria: rent");
    for (const m of await api.json("/api/assistant/memory")) await send("DELETE", `/api/assistant/memory/${m.id}`);
    expect(await api.json("/api/assistant/memory")).toEqual([]);
  });

  it("a month can wait for the pay to arrive", async () => {
    expect((await send("PUT", "/api/settings", { month_start: "pay", pay_wait_days: 30 })).status).toBe(400);
    expect((await send("PUT", "/api/settings", { month_start: "pay", pay_wait_days: 5 })).status).toBe(200);
    const pay = (await api.json("/api/transactions?category=income&limit=500")).rows.filter((t: any) => t.amount >= 1000).map((t: any) => t.date);
    const home = await api.json("/api/home");
    expect(pay).toContain(home.month.start);  // the month began the day pay landed
    await send("PUT", "/api/settings", { month_start: "payday" });
    expect((await api.json("/api/pace")).start).toBe("2026-09-25");
  });
});

