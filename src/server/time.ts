export interface LocalStamp {
  timestampMs: number;
  localDate: string;
  localTime: string;
}

const formatter = new Intl.DateTimeFormat("en-AU", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function partsOf(timestampMs: number): Record<string, string> {
  const parts = formatter.formatToParts(timestampMs);
  const result: Record<string, string> = {};
  for (const part of parts) {
    result[part.type] = part.value;
  }
  return result;
}

export function localStamp(now: number = Date.now()): LocalStamp {
  const parts = partsOf(now);
  return {
    timestampMs: now,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function formatLocalDateTime(timestampMs: number): string {
  const stamp = localStamp(timestampMs);
  return `${stamp.localDate} ${stamp.localTime}`;
}
