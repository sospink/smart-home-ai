import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function displayOperator(value?: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.toLowerCase() !== "system" ? normalized : "系统任务";
}
