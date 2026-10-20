/** Values more than one part of ebby relies on. Module-specific ones stay next to their use. */

/** An income deposit at least this big counts as pay: it marks payday, and the plan's take-home. */
export const PAYDAY_MIN = 1000;

/** The account cash logged by hand is kept in (logCash), apart from every bank account. */
export const CASH_ACCOUNT = "cash";

/** The models the chat and the sorter can use, by the name Settings shows. */
export const ASSISTANT_MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
