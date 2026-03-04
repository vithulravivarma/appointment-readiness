export type ScheduleAppointment = {
  clientName: string;
  startTime: string;
  endTime: string;
};

export type ScheduleOverviewOptions = {
  timeZone: string;
  currentBusinessDateIso: string;
  nowMs: number;
};

function shiftIsoDate(dateIso: string, deltaDays: number): string {
  const parts = String(dateIso || '').split('-').map((value) => Number(value));
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
    return dateIso;
  }
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return dateIso;
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(date.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function parseBusinessDateHint(command: string, currentBusinessDateIso: string): string | null {
  const raw = String(command || '');
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.includes('yesterday')) return shiftIsoDate(currentBusinessDateIso, -1);
  if (normalized.includes('today')) return currentBusinessDateIso;
  if (normalized.includes('tomorrow')) return shiftIsoDate(currentBusinessDateIso, 1);

  const isoMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const mdMatch = raw.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!mdMatch) return null;
  const month = Number(mdMatch[1]);
  const day = Number(mdMatch[2]);
  let year = mdMatch[3] ? Number(mdMatch[3]) : Number(String(currentBusinessDateIso).slice(0, 4));
  if (year < 100) year += 2000;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function resolveRequestedBusinessDate(
  command: string,
  memoryBusinessDateHint: string | undefined,
  currentBusinessDateIso: string,
): string {
  const hinted = parseBusinessDateHint(command, currentBusinessDateIso);
  if (hinted) return hinted;
  const memory = String(memoryBusinessDateHint || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(memory)) return memory;
  return currentBusinessDateIso;
}

export function formatBusinessDateLabel(dateIso: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || ''))) {
    return String(dateIso || '').trim() || 'unknown date';
  }
  const date = new Date(`${dateIso}T12:00:00-08:00`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return date.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBusinessTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDurationMinutes(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  if (hours > 0 && remainder > 0) return `${hours}h ${remainder}m`;
  if (hours > 0) return `${hours}h`;
  return `${remainder}m`;
}

export function buildScheduleOverviewResponse(
  appointments: ScheduleAppointment[],
  businessDate: string,
  options: ScheduleOverviewOptions,
): string {
  const dateLabel = formatBusinessDateLabel(businessDate, options.timeZone);
  if (appointments.length === 0) {
    return `No caregiver visits are scheduled for ${dateLabel}.`;
  }

  const lines = appointments.map(
    (row, idx) =>
      `${idx + 1}. ${formatBusinessTime(row.startTime, options.timeZone)}-${formatBusinessTime(row.endTime, options.timeZone)} • ${row.clientName}`,
  );

  const gaps: string[] = [];
  for (let i = 0; i < appointments.length - 1; i += 1) {
    const currentEnd = new Date(appointments[i].endTime).getTime();
    const nextStart = new Date(appointments[i + 1].startTime).getTime();
    if (!Number.isFinite(currentEnd) || !Number.isFinite(nextStart)) continue;
    const gapMinutes = Math.max(0, Math.round((nextStart - currentEnd) / 60000));
    gaps.push(
      `${formatDurationMinutes(gapMinutes)} between ${appointments[i].clientName} and ${appointments[i + 1].clientName}`,
    );
  }

  const isToday = businessDate === options.currentBusinessDateIso;
  const nextAppointment = appointments.find((item) => new Date(item.startTime).getTime() >= options.nowMs);
  const nextLine = isToday
    ? nextAppointment
      ? `Next visit: ${nextAppointment.clientName} at ${formatBusinessTime(nextAppointment.startTime, options.timeZone)}.`
      : 'All visits for this day are already in the past.'
    : `First visit: ${appointments[0].clientName} at ${formatBusinessTime(appointments[0].startTime, options.timeZone)}.`;
  const gapLine =
    gaps.length > 0
      ? `Gaps: ${gaps.join(' | ')}.`
      : appointments.length > 1
      ? 'Gaps: No break time between consecutive visits.'
      : 'Gaps: Single-visit day.';

  return [
    `${appointments.length} visit${appointments.length === 1 ? '' : 's'} on ${dateLabel}.`,
    nextLine,
    lines.join('\n'),
    gapLine,
  ].join('\n');
}

export function clampAppointmentIdsByLimit(appointmentIds: string[], limit: number): string[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of appointmentIds) {
    const normalized = String(id || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= safeLimit) {
      break;
    }
  }
  return out;
}
