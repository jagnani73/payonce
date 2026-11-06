import { useEffect, useState } from "preact/hooks";

// The page's one time format (glossary.md section 4): the viewer's time zone,
// a 24-hour clock, day before month. "14:20" today, "6 Nov, 14:20" earlier this
// year, "6 Nov 2025, 14:20" in another year. Ages and deadlines are relative.
// Every <time> carries the ISO value and the full local time with its zone.

const MONTHS: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE_MS: number = 60_000;
const HOUR_MS: number = 60 * MINUTE_MS;
const DAY_MS: number = 24 * HOUR_MS;
// Keeps a number on the line of its unit: "3 d" never breaks.
const NBSP: string = String.fromCharCode(0xa0);

export function parseIso(at: string | null | undefined): Date | null {
  if (typeof at !== "string" || at === "") {
    return null;
  }
  const date: Date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A day as stored, YYYY-MM-DD, at midnight local time.
export function parseDay(day: string | null | undefined): Date | null {
  const match: RegExpMatchArray | null = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  return match === null ? null : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const two = (n: number): string => String(n).padStart(2, "0");

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function clockOf(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// "8 Nov", or "8 Nov 2027" in another year.
export function dayText(date: Date, now: Date = new Date()): string {
  const base: string = `${date.getDate()} ${MONTHS[date.getMonth()] ?? ""}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

// "14:20", "6 Nov, 14:20" or "6 Nov 2025, 14:20".
export function timeText(date: Date, now: Date = new Date()): string {
  return sameDay(date, now) ? clockOf(date) : `${dayText(date, now)}, ${clockOf(date)}`;
}

function zoneName(date: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-GB", { timeZoneName: "long" })
        .formatToParts(date)
        .find((part: Intl.DateTimeFormatPart): boolean => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

// "6 Nov 2026, 13:40 India Standard Time", for the title of every <time>.
export function fullText(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ""} ${date.getFullYear()}, ${clockOf(date)} ${zoneName(date)}`.trim();
}

export function fullDayText(date: Date): string {
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// "Asia/Kolkata".
export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "your browser's time zone";
  }
}

// "under a minute", "12 min", "2 h", "3 d".
export function durationText(ms: number): string {
  const span: number = Math.abs(ms);
  if (span < MINUTE_MS) {
    return "under a minute";
  }
  if (span < HOUR_MS) {
    return `${Math.floor(span / MINUTE_MS)}${NBSP}min`;
  }
  if (span < DAY_MS) {
    return `${Math.floor(span / HOUR_MS)}${NBSP}h`;
  }
  return `${Math.floor(span / DAY_MS)}${NBSP}d`;
}

// "12 min ago", "just now".
export function agoText(date: Date, now: Date = new Date()): string {
  const ms: number = now.getTime() - date.getTime();
  return ms < MINUTE_MS ? "just now" : `${durationText(ms)} ago`;
}

// "in 38 min", or "12 min ago" once it has passed.
export function relativeText(date: Date, now: Date = new Date()): string {
  const ms: number = date.getTime() - now.getTime();
  if (ms <= 0) {
    return agoText(date, now);
  }
  return ms < MINUTE_MS ? "in under a minute" : `in ${durationText(ms)}`;
}

// One shared ticker, so relative times move on without a poll.
const listeners: Set<(now: Date) => void> = new Set();
let ticker: number = 0;

export function useNow(): Date {
  const [now, setNow] = useState<Date>((): Date => new Date());
  useEffect((): (() => void) => {
    listeners.add(setNow);
    if (ticker === 0) {
      ticker = window.setInterval((): void => {
        const at: Date = new Date();
        for (const listener of listeners) {
          listener(at);
        }
      }, 30_000);
    }
    return (): void => {
      listeners.delete(setNow);
      if (listeners.size === 0) {
        window.clearInterval(ticker);
        ticker = 0;
      }
    };
  }, []);
  return now;
}
