export const DEFAULT_DEADLINE_TIME_ZONE = "America/New_York";

const TIME_ZONE_ALIASES: Record<string, string> = {
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  UTC: "UTC", GMT: "UTC",
};

export type ParsedDeadline = {
  epochSeconds: number | null;
  timeZone: string;
};

export function normalizeTimeZone(value: unknown, fallback = DEFAULT_DEADLINE_TIME_ZONE) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const candidate = TIME_ZONE_ALIASES[value.trim().toUpperCase()] ?? value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return fallback;
  }
}

function timeZoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
}

function offsetAt(date: Date, timeZone: string) {
  const parts = timeZoneParts(date, timeZone);
  const displayedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return displayedAsUtc - date.getTime();
}

function localTimeToEpochSeconds(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guess = Date.UTC(year, month - 1, day, hour, minute, second) - offsetAt(new Date(guess), timeZone);
  }
  return Math.floor(guess / 1000);
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const second = Number(match[3] ?? "0");
  const meridiem = match[4]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * Parse an ISO timestamp or a small set of human-friendly deadline forms.
 * D1 stores the returned epochSeconds as an INTEGER; the timezone is kept
 * separately so the UI can display the original/intended local time.
 */
export function parseDeadlineInput(value: unknown, requestedTimeZone?: unknown): ParsedDeadline | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (explicitZone) {
    const timestamp = Date.parse(raw);
    if (Number.isNaN(timestamp)) return null;
    return { epochSeconds: Math.floor(timestamp / 1000), timeZone: normalizeTimeZone(requestedTimeZone, "UTC") };
  }

  const dateMatch = raw.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)(?:[T\s]+(.+))?$/);
  if (!dateMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const remainder = dateMatch[4]?.trim() ?? "";
  const clock = remainder ? parseClock(remainder.replace(/\s+(?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT)$/i, "").trim()) : { hour: 23, minute: 59, second: 0 };
  if (!clock) return null;
  const zoneMatch = remainder.match(/\b(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT)\b/i);
  const timeZone = normalizeTimeZone(zoneMatch?.[1] ?? requestedTimeZone);
  const epochSeconds = localTimeToEpochSeconds(year, month, day, clock.hour, clock.minute, clock.second, timeZone);
  const verified = new Date(epochSeconds * 1000);
  if (Number.isNaN(verified.getTime())) return null;
  return { epochSeconds, timeZone };
}

export function deadlineIso(epochSeconds: unknown) {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === "") return null;
  const numeric = Number(epochSeconds);
  if (!Number.isFinite(numeric)) return null;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
