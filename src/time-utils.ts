// Provides timezone-aware formatting and local wall-clock scheduling helpers.
export type LocalTimeParts = {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
};

// Formats an ISO timestamp in a user timezone while staying readable in chat.
export function formatIsoInTimeZone(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  if (!timeZone) {
    return date.toISOString();
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const partMap = formatter.formatToParts(date).reduce<Record<string, string>>((accumulator, part) => {
      if (part.type !== 'literal') {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});

    const year = partMap.year ?? '1970';
    const month = partMap.month ?? '01';
    const day = partMap.day ?? '01';
    const hour = partMap.hour ?? '00';
    const minute = partMap.minute ?? '00';
    return `${year}-${month}-${day} ${hour}:${minute} ${timeZone}`;
  } catch {
    return date.toISOString();
  }
}

// Validates that a timezone name is recognized by the JS runtime.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// Builds a local date key used for transcript and digest grouping.
export function currentDateKey(timeZone?: string, now = new Date()): string {
  if (!timeZone) {
    return now.toISOString().slice(0, 10);
  }

  const parts = getLocalTimeParts(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Builds a local month key used for monthly recurring tasks.
export function currentMonthKey(timeZone?: string, now = new Date()): string {
  if (!timeZone) {
    return now.toISOString().slice(0, 7);
  }

  const parts = getLocalTimeParts(now, timeZone);
  return `${parts.year}-${parts.month}`;
}

// Resolves the last minute of the current local month into an absolute ISO timestamp.
export function endOfMonthDueIso(timeZone: string, now = new Date()): string {
  const parts = getLocalTimeParts(now, timeZone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return findLocalDateTimeIso(
    timeZone,
    parts.year,
    parts.month,
    String(lastDay).padStart(2, '0'),
    23,
    59
  );
}

// Searches for the real UTC instant that matches a target local wall-clock time.
export function findLocalDateTimeIso(
  timeZone: string,
  year: string,
  month: string,
  day: string,
  hour: number,
  minute: number
): string {
  const targetYear = Number(year);
  const targetMonth = Number(month);
  const targetDay = Number(day);
  const approxMs = Date.UTC(targetYear, targetMonth - 1, targetDay, hour, minute);
  const startMs = approxMs - 36 * 60 * 60 * 1000;
  const endMs = approxMs + 36 * 60 * 60 * 1000;

  for (let candidateMs = startMs; candidateMs <= endMs; candidateMs += 60 * 1000) {
    const parts = getLocalTimeParts(new Date(candidateMs), timeZone);
    if (
      parts.year === year
      && parts.month === month
      && parts.day === day
      && parts.hour === hour
      && parts.minute === minute
    ) {
      return new Date(candidateMs).toISOString();
    }
  }

  throw new Error(`Could not resolve local time ${year}-${month}-${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} in timezone ${timeZone}`);
}

// Extracts local calendar/time parts for a UTC instant in a given timezone.
export function getLocalTimeParts(date: Date, timeZone: string): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const partMap = formatter.formatToParts(date).reduce<Record<string, string>>((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    year: partMap.year ?? '1970',
    month: partMap.month ?? '01',
    day: partMap.day ?? '01',
    hour: Number(partMap.hour ?? '0'),
    minute: Number(partMap.minute ?? '0'),
  };
}
