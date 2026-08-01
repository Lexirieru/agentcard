"use client";

import { useEffect, useState } from "react";

export interface Clock {
  /** Epoch ms. `0` until the client has mounted. */
  nowMs: number;
  /** False during SSR and the first client render. */
  ready: boolean;
}

/**
 * A coarse ticking clock.
 *
 * Deliberately starts at `{ nowMs: 0, ready: false }` so the server-rendered
 * HTML and the first client render are identical — reading `Date.now()` during
 * render is the classic hydration mismatch, and every panel here shows relative
 * times. Consumers render a placeholder until `ready`.
 *
 * 30s resolution: expiry countdowns are shown in minutes and hours, so a
 * faster tick would re-render the tree for no visible change.
 */
export function useNow(intervalMs = 30_000): Clock {
  const [clock, setClock] = useState<Clock>({ nowMs: 0, ready: false });

  useEffect(() => {
    const tick = () => setClock({ nowMs: Date.now(), ready: true });
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return clock;
}
