/** What web push's routes return. */

import { z } from "zod";

/** The applicationServerKey browsers subscribe with: the public half only. */
export const PushKey = z.strictObject({ key: z.string() });
export const PushDevices = z.strictObject({ devices: z.number() });
export const PushSent = z.strictObject({ sent: z.number() });

export const schemas = { PushKey, PushDevices, PushSent };

export const responses = {
  "GET /api/push/key": PushKey,
  "POST /api/push/subscribe": PushDevices,
  "POST /api/push/unsubscribe": PushDevices,
  "POST /api/push/test": PushSent,
};
