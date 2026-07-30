import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Last matching item without copying and reversing the array. (The native
 * Array#findLast needs a lib newer than this project's TypeScript target.)
 */
export function findLast<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}
