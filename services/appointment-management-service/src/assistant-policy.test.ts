import {
  buildScheduleOverviewResponse,
  clampAppointmentIdsByLimit,
  formatBusinessDateLabel,
  parseBusinessDateHint,
  resolveRequestedBusinessDate,
  type ScheduleAppointment,
} from './assistant-policy';

const TZ = 'America/Los_Angeles';

describe('assistant-policy', () => {
  test('formats business date labels with explicit date context', () => {
    const label = formatBusinessDateLabel('2026-03-01', TZ);
    expect(label).toContain('Mar');
    expect(label).toContain('2026');
  });

  test('schedule overview uses first-visit phrasing for non-today dates', () => {
    const appointments: ScheduleAppointment[] = [
      {
        clientName: 'Alex',
        startTime: '2026-03-01T17:00:00.000Z',
        endTime: '2026-03-01T18:00:00.000Z',
      },
      {
        clientName: 'Bianca',
        startTime: '2026-03-01T19:00:00.000Z',
        endTime: '2026-03-01T20:00:00.000Z',
      },
    ];

    const summary = buildScheduleOverviewResponse(appointments, '2026-03-01', {
      timeZone: TZ,
      currentBusinessDateIso: '2026-02-28',
      nowMs: Date.parse('2026-02-28T20:00:00.000Z'),
    });

    expect(summary).toContain('First visit: Alex');
    expect(summary).not.toContain('Next visit:');
  });

  test('schedule overview uses next-visit phrasing for current business date', () => {
    const appointments: ScheduleAppointment[] = [
      {
        clientName: 'Alex',
        startTime: '2026-03-01T17:00:00.000Z',
        endTime: '2026-03-01T18:00:00.000Z',
      },
    ];

    const summary = buildScheduleOverviewResponse(appointments, '2026-03-01', {
      timeZone: TZ,
      currentBusinessDateIso: '2026-03-01',
      nowMs: Date.parse('2026-03-01T15:30:00.000Z'),
    });

    expect(summary).toContain('Next visit: Alex');
  });

  test('clamps appointment ids by limit and removes duplicates', () => {
    const scoped = clampAppointmentIdsByLimit(['a', 'b', 'a', 'c'], 2);
    expect(scoped).toEqual(['a', 'b']);
  });

  test('parses relative date hints for maps/schedule flows', () => {
    const date = parseBusinessDateHint('Can you map tomorrow route?', '2026-02-27');
    expect(date).toBe('2026-02-28');
  });

  test('resolves requested business date from command, then memory, then current date', () => {
    expect(resolveRequestedBusinessDate('schedule for 03/02', '2026-02-20', '2026-02-27')).toBe('2026-03-02');
    expect(resolveRequestedBusinessDate('show schedule', '2026-02-20', '2026-02-27')).toBe('2026-02-20');
    expect(resolveRequestedBusinessDate('show schedule', undefined, '2026-02-27')).toBe('2026-02-27');
  });
});
