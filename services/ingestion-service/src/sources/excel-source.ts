import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { IngestionPayload } from '../repository';
import { IngestionBatchResult, IngestionSource } from './types';

const execFileAsync = promisify(execFile);

type Row = Record<string, string>;

export interface ExcelIngestionSourceOptions {
  appointmentsFile: string;
  clientFile: string;
  staffFile?: string;
}

export class ExcelIngestionSource implements IngestionSource {
  private readonly appointmentsFile: string;
  private readonly clientFile: string;
  private readonly staffFile?: string;

  constructor(options: ExcelIngestionSourceOptions) {
    this.appointmentsFile = options.appointmentsFile;
    this.clientFile = options.clientFile;
    this.staffFile = options.staffFile;
  }

  async load(): Promise<IngestionBatchResult> {
    const [appointmentRows, clientRows, staffRows] = await Promise.all([
      readSheetRows(this.appointmentsFile),
      readSheetRows(this.clientFile),
      this.staffFile ? readSheetRows(this.staffFile) : Promise.resolve([]),
    ]);

    const clientsByAppointmentId = new Map<string, Row>();
    const clientsByName = new Map<string, Row>();
    for (const row of clientRows) {
      const appointmentId = normalizeId(row['Appointment ID'] || row['Appt. ID']);
      if (!appointmentId) {
        const clientNameKey = normalizePersonName(row['Client Name']);
        if (clientNameKey && !clientsByName.has(clientNameKey)) {
          clientsByName.set(clientNameKey, row);
        }
      } else {
        clientsByAppointmentId.set(appointmentId, row);

        const clientNameKey = normalizePersonName(row['Client Name']);
        if (clientNameKey && !clientsByName.has(clientNameKey)) {
          clientsByName.set(clientNameKey, row);
        }
      }
    }
    const staffByName = buildStaffLookup(staffRows);

    const deduped = new Map<string, IngestionPayload>();
    const clientMatchesByAppointmentId = new Set<string>();
    const clientMatchesByName = new Set<string>();
    const staffMatchesByName = new Set<string>();

    for (const row of appointmentRows) {
      const appointmentId = normalizeId(row['Appt. ID'] || row['Appointment ID']);
      if (!appointmentId) {
        continue;
      }

      const matchedByAppointment = clientsByAppointmentId.get(appointmentId);
      const matchedByName = !matchedByAppointment
        ? clientsByName.get(normalizePersonName(row['Client Name']))
        : undefined;
      const client = matchedByAppointment || matchedByName || {};

      if (matchedByAppointment) {
        clientMatchesByAppointmentId.add(appointmentId);
      } else if (matchedByName) {
        clientMatchesByName.add(appointmentId);
      }

      const clientName = firstNonEmpty(client['Client Name'], row['Client Name'], 'Unknown Client');
      const caregiverName = firstNonEmpty(row['Staff Name'], client['Staff Name'], 'Unknown Caregiver');
      const staff = staffByName.get(normalizePersonName(caregiverName));
      if (staff) {
        staffMatchesByName.add(appointmentId);
      }

      const startTime = toAppointmentDateTimeIso(
        firstNonEmpty(row['Appt. Date'], client['Appt. Date']),
        firstNonEmpty(row['Appt. Start Time'], client['Appt. Start Time']),
      );
      const endTime = toAppointmentDateTimeIso(
        firstNonEmpty(row['Appt. Date'], client['Appt. Date']),
        firstNonEmpty(row['Appt. End Time'], client['Appt. End Time']),
      );
      const normalizedTimes = normalizeStartEnd(startTime, endTime);

      deduped.set(appointmentId, {
        alohaAppointmentId: appointmentId,
        startTime: normalizedTimes.start,
        endTime: normalizedTimes.end,
        serviceType:
          row['Service Name'] ||
          client['Service Name'] ||
          row['Appt. Type'] ||
          client['Billing Code'] ||
          'General Service',
        location:
          row['Appt. Location'] ||
          client['Appointment Location'] ||
          client['Patient Address'] ||
          '',
        client: {
          alohaId: normalizeId(client['Client ID']) || fallbackExternalId('CLIENT', clientName),
          name: clientName,
          phone: '',
          address:
            client['Patient Address'] ||
            client['Appointment Location'] ||
            row['Appt. Location'] ||
            '',
        },
        caregiver: {
          alohaId: normalizeId(staff?.['Staff Id']) || fallbackExternalId('CG', caregiverName),
          name: caregiverName,
          phone: cleanPhone(staff?.Phone),
          email: normalizeEmail(staff?.Primary_Email) || fallbackEmail(caregiverName),
          homeAddress: composeStaffHomeAddress(staff),
        },
      });
    }

    return {
      appointments: Array.from(deduped.values()),
      metadata: {
        source: 'excel',
        appointmentsFile: path.basename(this.appointmentsFile),
        clientFile: path.basename(this.clientFile),
        staffFile: this.staffFile ? path.basename(this.staffFile) : 'none',
        appointmentRows: appointmentRows.length,
        clientRows: clientRows.length,
        staffRows: staffRows.length,
        mappedAppointments: deduped.size,
        clientMatchesByAppointmentId: clientMatchesByAppointmentId.size,
        clientMatchesByName: clientMatchesByName.size,
        staffMatchesByName: staffMatchesByName.size,
      },
    };
  }
}

async function readSheetRows(filePath: string): Promise<Row[]> {
  const xml = await readSheetXml(filePath);
  return parseRows(xml);
}

async function readSheetXml(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', filePath, 'xl/worksheets/sheet1.xml'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function parseRows(xml: string): Row[] {
  const rowMatches = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
  if (rowMatches.length === 0) {
    return [];
  }

  const headerRow = parseCellMap(rowMatches[0] || '');
  const headersByColumn = new Map<string, string>();
  for (const [col, value] of Object.entries(headerRow)) {
    if (value) {
      headersByColumn.set(col, value);
    }
  }

  const rows: Row[] = [];
  for (let i = 1; i < rowMatches.length; i += 1) {
    const cellMap = parseCellMap(rowMatches[i] || '');
    const record: Row = {};
    for (const [col, value] of Object.entries(cellMap)) {
      const header = headersByColumn.get(col);
      if (!header) {
        continue;
      }
      record[header] = value;
    }

    if (Object.values(record).some((v) => v !== '')) {
      rows.push(record);
    }
  }

  return rows;
}

function parseCellMap(rowXml: string): Row {
  const cells = rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
  const map: Row = {};

  for (const cell of cells) {
    const ref = cell.match(/\br="([A-Z]+)\d+"/)?.[1];
    if (!ref) {
      continue;
    }

    const rawValue =
      cell.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ||
      cell.match(/<is>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/is>/)?.[1] ||
      '';
    map[ref] = decodeXml(rawValue.trim());
  }

  return map;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeId(value: string | undefined): string {
  return String(value || '').trim();
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizePersonName(value: string | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/[^a-z0-9]+/g, '');
}

function buildStaffLookup(rows: Row[]): Map<string, Row> {
  const byName = new Map<string, Row>();

  for (const row of rows) {
    const first = firstNonEmpty(row.FirstName);
    const last = firstNonEmpty(row.LastName);
    const alias = firstNonEmpty(row.Alias);
    const combinedLastFirst = [last, first].filter(Boolean).join(', ');
    const combinedFirstLast = [first, last].filter(Boolean).join(' ');
    const keys = [combinedLastFirst, combinedFirstLast, alias]
      .map((name) => normalizePersonName(name))
      .filter(Boolean);

    for (const key of keys) {
      if (!byName.has(key)) {
        byName.set(key, row);
      }
    }
  }

  return byName;
}

function fallbackExternalId(prefix: string, name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!token) {
    return `${prefix}-unknown`;
  }

  return `${prefix}-${token}`;
}

function fallbackEmail(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');

  if (!token) {
    return '';
  }

  return `${token}@example.local`;
}

function cleanPhone(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const digits = raw.replace(/\D+/g, '');
  if (!digits) {
    return '';
  }

  return digits;
}

function normalizeEmail(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    return '';
  }
  return normalized;
}

function composeStaffHomeAddress(staff: Row | undefined): string {
  if (!staff) {
    return '';
  }

  const line1 = firstNonEmpty(staff.Address);
  const city = firstNonEmpty(staff.City);
  const state = firstNonEmpty(staff.State);
  const zip = firstNonEmpty(staff.Zip);
  const cityStateZip = [city, state, zip].filter(Boolean).join(', ');
  const full = [line1, cityStateZip].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();
  return full;
}

function toAppointmentDateTimeIso(excelSerialDate: string, timeLabel: string): string {
  const dateParts = parseExcelDate(excelSerialDate);
  const timeParts = parse12HourTime(timeLabel);
  if (!dateParts || !timeParts) {
    return new Date().toISOString();
  }

  const date = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      timeParts.hours,
      timeParts.minutes,
      0,
      0,
    ),
  );

  return date.toISOString();
}

function parseExcelDate(serialText: string): { year: number; month: number; day: number } | null {
  const serial = Number(serialText);
  if (Number.isNaN(serial) || serial <= 0) {
    return null;
  }

  const base = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(base.getTime() + Math.floor(serial) * 24 * 60 * 60 * 1000);

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parse12HourTime(timeLabel: string): { hours: number; minutes: number } | null {
  const value = String(timeLabel || '').trim();
  const match = value.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3].toUpperCase();

  if (period === 'PM' && hours !== 12) {
    hours += 12;
  }

  if (period === 'AM' && hours === 12) {
    hours = 0;
  }

  return { hours, minutes };
}

function normalizeStartEnd(startIso: string, endIso: string): { start: string; end: string } {
  const start = new Date(startIso);
  const end = new Date(endIso);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { start: startIso, end: endIso };
  }

  if (end <= start) {
    end.setUTCDate(end.getUTCDate() + 1);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
