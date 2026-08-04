import { useEffect, useRef, useState } from "react";
import { createSettler, type Settler } from "./settle";

/**
 * The value once it has stopped changing.
 *
 * Starts at `value`, so the first render is not delayed, and then trails it by
 * `delayMs` of quiet. Used where acting on every intermediate value would cost
 * something real — a billed call, a round trip — and only the value the reader
 * came to rest on was ever meant.
 */
export function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  const settlerRef = useRef<Settler<T> | null>(null);
  if (!settlerRef.current) {
    settlerRef.current = createSettler<T>(delayMs, setSettled);
  }

  useEffect(() => {
    settlerRef.current?.push(value);
  }, [value]);

  useEffect(() => () => settlerRef.current?.cancel(), []);

  return settled;
}
