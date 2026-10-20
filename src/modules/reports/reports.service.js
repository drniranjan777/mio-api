import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { grantedDoctorIds } from '../access/access.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { dayBounds, formatTime, localParts } from '../appointments/schedule.js';
import { DoctorProfile } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';

const { ObjectId } = mongoose.Types;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 2000;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Report catalogue. `audience` decides who may run it; `adminOnly` reports are
 * hidden from that audience in the apps (App Corrections, 18 Oct 2026: the
 * company & employee summary was removed from the MR app) but stay in the panel.
 */
export const REPORTS = Object.freeze({
  // MR reports
  'visit-frequency': { audience: 'mr', title: 'MR Wise Date-Wise Visit Frequency Report' },
  'company-summary': { audience: 'mr', adminOnly: true, title: 'Company & Employee-Wise Visit Summary Report' },
  'monthly-visit-dates': { audience: 'mr', title: 'Monthly Employee-Wise Total Visit Dates Report' },
  'confirmation-cancellation': { audience: 'mr', title: 'Appointment Confirmation & MR Cancellation Report' },
  'high-visit': { audience: 'mr', title: 'Company & Division-Wise High Visit MR Report' },
  performance: { audience: 'mr', title: 'MR Visit Performance & Activity Report' },
  'doctor-visits': { audience: 'mr', title: 'Doctor Visit Details Report' },
  // Doctor / receptionist reports
  'company-visits': { audience: 'doctor', title: 'Company Visit Reports' },
  compliance: { audience: 'doctor', title: 'Appointment Compliance Reports' },
  'time-management': { audience: 'doctor', title: 'Doctor Time Management Reports' },
  monitoring: { audience: 'doctor', title: 'Appointment Monitoring Reports' },
  'mr-wise': { audience: 'doctor', title: 'Other Reports — MR-Wise Visits' },
});

const audienceOf = (role) => (role === 'mr' ? 'mr' : role === 'admin' ? 'any' : 'doctor');

export function catalogue(actor) {
  const audience = audienceOf(actor.role);
  return Object.entries(REPORTS)
    .filter(([, r]) => audience === 'any' || (r.audience === audience && !r.adminOnly))
    .map(([type, r]) => ({ type, title: r.title }));
}

// ---- Scope & filters ------------------------------------------------------------

function range(query) {
  const shift = (days) => localParts(new Date(Date.now() + days * DAY_MS)).dateStr;
  const from = query.from ?? shift(-30);
  const to = query.to ?? shift(30);
  if (to < from) throw ApiError.badRequest('"To" date must be on or after "From" date', undefined, 'VALIDATION_ERROR');
  const start = dayBounds(from).start;
  const end = dayBounds(to).end;
  if ((end - start) / DAY_MS > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`Reports cover at most ${MAX_RANGE_DAYS} days`, undefined, 'VALIDATION_ERROR');
  }
  return { from, to, start, end };
}

/** Base Mongo filter: what this user is allowed to see, never widened by the query. */
async function scopeFilter(actor, query) {
  const filter = {};
  if (actor.role === 'mr') filter.mr = actor._id;
  if (actor.role === 'doctor') filter.doctor = actor._id;
  if (actor.role === 'receptionist') {
    const allowed = await grantedDoctorIds(actor._id);
    if (query.doctorId && !allowed.includes(query.doctorId)) {
      throw ApiError.forbidden('You do not have access to this doctor', 'DOCTOR_FORBIDDEN');
    }
    filter.doctor = { $in: (query.doctorId ? [query.doctorId] : allowed).map((id) => new ObjectId(id)) };
  }
  if (actor.role === 'admin') {
    if (query.doctorId) filter.doctor = new ObjectId(query.doctorId);
    if (query.mrId) filter.mr = new ObjectId(query.mrId);
  }
  if (actor.role === 'mr' && query.doctorId) filter.doctor = new ObjectId(query.doctorId);
  if (['doctor', 'receptionist'].includes(actor.role) && query.mrId) filter.mr = new ObjectId(query.mrId);
  return filter;
}

async function buildFilter(actor, query) {
  const filter = await scopeFilter(actor, query);
  const { start, end, from, to } = range(query);
  filter.startAt = { $gte: start, $lt: end };
  // An MR's reports cover only their own visits, so there is no company choice for them.
  if (query.company && actor.role !== 'mr') filter['visitor.company'] = new RegExp(`^${escapeRegex(query.company)}$`, 'i');
  if (query.specialty || query.city) {
    const pf = {};
    if (query.specialty) pf.specialty = new RegExp(`^${escapeRegex(query.specialty)}$`, 'i');
    if (query.city) pf['practice.city'] = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
    const ids = await DoctorProfile.find(pf).distinct('user');
    filter.doctor = filter.doctor ? { $in: ids.filter((id) => matchesDoctor(filter.doctor, id)) } : { $in: ids };
  }
  return { filter, from, to };
}

function matchesDoctor(current, id) {
  if (current instanceof ObjectId) return current.equals(id);
  if (current?.$in) return current.$in.some((d) => d.toString() === id.toString());
  return current?.toString() === id.toString();
}

/** Dropdown values for the report filter card, limited to the user's own data. */
export async function filterOptions(actor) {
  const base = await scopeFilter(actor, {});
  base.startAt = { $gte: new Date(Date.now() - 365 * DAY_MS) };
  const [companies, mrIds, doctorIds] = await Promise.all([
    actor.role === 'mr' ? [] : Appointment.distinct('visitor.company', base),
    actor.role === 'mr' ? [] : Appointment.distinct('mr', base),
    Appointment.distinct('doctor', base),
  ]);
  const [mrs, doctors, profiles] = await Promise.all([
    User.find({ _id: { $in: mrIds }, status: { $ne: 'deleted' } }).select('name').sort({ name: 1 }).lean(),
    User.find({ _id: { $in: doctorIds }, status: { $ne: 'deleted' } }).select('name').sort({ name: 1 }).lean(),
    DoctorProfile.find({ user: { $in: doctorIds } }).select('specialty practice.city').lean(),
  ]);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    reports: catalogue(actor),
    companies: uniq(companies),
    mrs: mrs.map((u) => ({ id: u._id.toString(), name: u.name })),
    doctors: doctors.map((u) => ({ id: u._id.toString(), name: u.name })),
    specialties: uniq(profiles.map((p) => p.specialty)),
    cities: uniq(profiles.map((p) => p.practice?.city)),
  };
}

// ---- Report builders --------------------------------------------------------------

const statusCounts = {
  visits: { $sum: 1 },
  approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
  pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
  completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
  cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
};
const statusColumns = [
  ['visits', 'Visits'],
  ['approved', 'Approved'],
  ['pending', 'Pending'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
];
/** Mongo `timezone` for the configured local offset, e.g. "+05:30". */
function tz() {
  const off = env.TZ_OFFSET_MINUTES;
  const abs = Math.abs(off);
  return `${off < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const cols = (pairs) => pairs.map(([key, label]) => ({ key, label }));

async function groupBy(filter, id, sort = { visits: -1 }) {
  return Appointment.aggregate([{ $match: filter }, { $group: { _id: id, ...statusCounts } }, { $sort: sort }, { $limit: MAX_ROWS }]);
}

async function namesFor(ids) {
  const users = await User.find({ _id: { $in: ids.filter(Boolean) } }).select('name status').lean();
  return new Map(users.map((u) => [u._id.toString(), u.status === 'deleted' ? 'Former user' : u.name]));
}

/**
 * Doctor details allowed in any report or export: name, specialty,
 * clinic/hospital and city/area. Mobile numbers, dates of birth and marriage
 * dates are never read here, so they cannot leak into a download.
 */
const doctorColumns = [
  ['doctor', 'Doctor Name'],
  ['specialty', 'Specialty'],
  ['clinic', 'Clinic / Hospital'],
  ['city', 'City / Area'],
];

async function doctorDetails(ids) {
  const profiles = await DoctorProfile.find({ user: { $in: ids.filter(Boolean) } })
    .select('user specialty practice.clinicName practice.city')
    .lean();
  return new Map(profiles.map((p) => [p.user.toString(), p]));
}

function doctorCells(id, names, byDoc) {
  const p = byDoc.get(id?.toString());
  return {
    doctor: names.get(id?.toString()) ?? '—',
    specialty: p?.specialty ?? '—',
    clinic: p?.practice?.clinicName ?? '—',
    city: p?.practice?.city ?? '—',
  };
}

const BUILDERS = {
  async 'visit-frequency'(filter) {
    const rows = await groupBy(filter, { $dateToString: { format: '%Y-%m-%d', date: '$startAt', timezone: tz() } }, { _id: 1 });
    return {
      columns: cols([['date', 'Date'], ...statusColumns]),
      rows: rows.map(({ _id, ...r }) => ({ date: _id, ...r })),
    };
  },

  async 'company-summary'(filter) {
    const rows = await groupBy(filter, '$doctor');
    const [names, byDoc] = await Promise.all([namesFor(rows.map((r) => r._id)), doctorDetails(rows.map((r) => r._id))]);
    return {
      columns: cols([...doctorColumns, ...statusColumns]),
      rows: rows.map(({ _id, ...r }) => ({ ...doctorCells(_id, names, byDoc), ...r })),
    };
  },

  /** One row per visit with the doctor's public practice details only. */
  async 'doctor-visits'(filter) {
    const appts = await Appointment.find(filter).sort({ startAt: 1 }).limit(MAX_ROWS).select('doctor startAt status').lean();
    const ids = appts.map((a) => a.doctor);
    const [names, byDoc] = await Promise.all([namesFor(ids), doctorDetails(ids)]);
    return {
      columns: cols([['date', 'Date'], ['time', 'Time'], ...doctorColumns, ['status', 'Status']]),
      rows: appts.map((a) => ({
        date: localParts(a.startAt).dateStr,
        time: formatTime(a.startAt),
        ...doctorCells(a.doctor, names, byDoc),
        status: a.status[0].toUpperCase() + a.status.slice(1),
      })),
    };
  },

  async 'monthly-visit-dates'(filter) {
    const rows = await Appointment.aggregate([
      { $match: { ...filter, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: {
            m: { $dateToString: { format: '%Y-%m', date: '$startAt', timezone: tz() } },
            d: { $dateToString: { format: '%Y-%m-%d', date: '$startAt', timezone: tz() } },
          },
          n: { $sum: 1 },
        },
      },
      { $group: { _id: '$_id.m', visitDates: { $sum: 1 }, visits: { $sum: '$n' } } },
      { $sort: { _id: 1 } },
    ]);
    return {
      columns: cols([['month', 'Month'], ['visitDates', 'Visit Dates'], ['visits', 'Visits']]),
      rows: rows.map(({ _id, ...r }) => ({ month: _id, ...r })),
    };
  },

  async 'confirmation-cancellation'(filter) {
    const rows = await Appointment.aggregate([
      { $match: filter },
      { $group: { _id: { s: '$status', by: '$cancel.role' }, n: { $sum: 1 } } },
    ]);
    const total = rows.reduce((a, r) => a + r.n, 0);
    const label = (s, by) =>
      s === 'cancelled' ? `Cancelled by ${by === 'mr' ? 'MR' : by ? by[0].toUpperCase() + by.slice(1) : 'system'}` : s[0].toUpperCase() + s.slice(1);
    return {
      columns: cols([['outcome', 'Outcome'], ['count', 'Appointments'], ['share', 'Share %']]),
      rows: rows
        .map((r) => ({ outcome: label(r._id.s, r._id.by), count: r.n, share: pct(r.n, total) }))
        .sort((a, b) => b.count - a.count),
    };
  },

  async 'high-visit'(filter) {
    const rows = await groupBy(filter, { company: '$visitor.company', division: '$visitor.division' });
    return {
      columns: cols([['company', 'Company'], ['division', 'Division'], ...statusColumns]),
      rows: rows.map(({ _id, ...r }) => ({ company: _id.company ?? '—', division: _id.division ?? '—', ...r })),
    };
  },

  async performance(filter) {
    const [totals] = await Appointment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          ...statusCounts,
          doctors: { $addToSet: '$doctor' },
          days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$startAt', timezone: tz() } } },
        },
      },
    ]);
    const t = totals ?? { visits: 0, approved: 0, pending: 0, completed: 0, cancelled: 0, doctors: [], days: [] };
    const rows = [
      ['Total appointments', t.visits],
      ['Approved', t.approved],
      ['Pending', t.pending],
      ['Completed visits', t.completed],
      ['Cancelled', t.cancelled],
      ['Distinct doctors', t.doctors.length],
      ['Active days', t.days.length],
      ['Avg. appointments per active day', t.days.length ? Math.round((t.visits / t.days.length) * 10) / 10 : 0],
      ['Completion rate %', pct(t.completed, t.visits - t.cancelled - t.pending)],
      ['Cancellation rate %', pct(t.cancelled, t.visits)],
    ];
    return { columns: cols([['metric', 'Metric'], ['value', 'Value']]), rows: rows.map(([metric, value]) => ({ metric, value })) };
  },

  async 'company-visits'(filter) {
    const rows = await Appointment.aggregate([
      { $match: filter },
      { $group: { _id: '$visitor.company', ...statusCounts, mrs: { $addToSet: '$visitor.name' } } },
      { $sort: { visits: -1 } },
      { $limit: MAX_ROWS },
    ]);
    return {
      columns: cols([['company', 'Company'], ['mrs', 'MRs'], ...statusColumns]),
      rows: rows.map(({ _id, mrs, ...r }) => ({ company: _id ?? '—', mrs: mrs.length, ...r })),
    };
  },

  async compliance(filter) {
    return BUILDERS['confirmation-cancellation'](filter);
  },

  async 'time-management'(filter) {
    const rows = await Appointment.aggregate([
      { $match: { ...filter, status: { $ne: 'cancelled' } } },
      { $group: { _id: { $hour: { date: '$startAt', timezone: tz() } }, visits: { $sum: 1 }, minutes: { $sum: { $divide: [{ $subtract: ['$endAt', '$startAt'] }, 60000] } } } },
      { $sort: { _id: 1 } },
    ]);
    const hour = (h) => `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:00 ${h < 12 ? 'AM' : 'PM'}`;
    return {
      columns: cols([['slot', 'Time Slot'], ['visits', 'Visits'], ['minutes', 'Minutes Given']]),
      rows: rows.map((r) => ({ slot: `${hour(r._id)} - ${hour((r._id + 1) % 24)}`, visits: r.visits, minutes: Math.round(r.minutes) })),
    };
  },

  async monitoring(filter) {
    const appts = await Appointment.find(filter).sort({ startAt: 1 }).limit(MAX_ROWS).populate('doctor', 'name').lean();
    return {
      columns: cols([
        ['date', 'Date'],
        ['time', 'Time'],
        ['doctor', 'Doctor'],
        ['mr', 'MR'],
        ['company', 'Company'],
        ['status', 'Status'],
        ['bookedBy', 'Booked By'],
        ['lastAction', 'Last Action'],
      ]),
      rows: appts.map((a) => {
        const last = a.history?.at(-1);
        return {
          date: localParts(a.startAt).dateStr,
          time: formatTime(a.startAt),
          doctor: a.doctor?.name ?? '—',
          mr: a.visitor?.name ?? '—',
          company: a.visitor?.company ?? '—',
          status: a.status,
          bookedBy: a.createdBy?.role ?? '—',
          lastAction: last ? `${last.action} (${last.role})` : '—',
        };
      }),
    };
  },

  async 'mr-wise'(filter) {
    const rows = await groupBy(filter, { name: '$visitor.name', company: '$visitor.company' });
    return {
      columns: cols([['mr', 'MR Name'], ['company', 'Company'], ...statusColumns]),
      rows: rows.map(({ _id, ...r }) => ({ mr: _id.name ?? '—', company: _id.company ?? '—', ...r })),
    };
  },
};

export async function runReport(actor, type, query) {
  const def = REPORTS[type];
  if (!def) throw ApiError.notFound('Unknown report', 'REPORT_NOT_FOUND');
  const audience = audienceOf(actor.role);
  if (audience !== 'any' && (def.audience !== audience || def.adminOnly)) {
    throw ApiError.forbidden('This report is not available for your role', 'REPORT_FORBIDDEN');
  }

  const { filter, from, to } = await buildFilter(actor, query);
  const { columns, rows } = await BUILDERS[type](filter);
  return { type, title: def.title, from, to, generatedAt: new Date(), columns, rows, truncated: rows.length >= MAX_ROWS };
}

/** Quick counters for each report tile (one aggregate for the whole range). */
export async function summary(actor, query) {
  const { filter, from, to } = await buildFilter(actor, query);
  const [t] = await Appointment.aggregate([{ $match: filter }, { $group: { _id: null, ...statusCounts } }]);
  const { _id, ...counts } = t ?? { _id: null, visits: 0, approved: 0, pending: 0, completed: 0, cancelled: 0 };
  return { from, to, ...counts, reports: catalogue(actor) };
}

// ---- PDF ------------------------------------------------------------------------------

const PDF_BRAND = '#0864AC';
const PDF_MARGIN = 36;

/**
 * A4 landscape table: title, period, repeating blue header row, zebra rows
 * and page numbers. Columns share the width in proportion to their content.
 * Built in memory; reports are capped at MAX_ROWS so the size stays bounded.
 */
export function toPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PDF_MARGIN, bufferPages: true, info: { Title: report.title, Author: 'Mio Doctors' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - PDF_MARGIN * 2;
    const bottom = doc.page.height - PDF_MARGIN - 18;
    const text = (v) => (v === null || v === undefined ? '' : String(v));
    const weights = report.columns.map((c) =>
      Math.min(Math.max(c.label.length, ...report.rows.slice(0, 200).map((r) => text(r[c.key]).length), 6), 40),
    );
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const widths = weights.map((w) => (w / total) * width);
    const fontSize = report.columns.length > 8 ? 7.5 : 9;
    const pad = 4;

    const rowHeight = (cells, font) => {
      doc.font(font).fontSize(fontSize);
      return Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - pad * 2 }))) + pad * 2;
    };
    const drawRow = (cells, y, { font, fill, color }) => {
      const h = rowHeight(cells, font);
      if (fill) doc.rect(PDF_MARGIN, y, width, h).fill(fill);
      let x = PDF_MARGIN;
      doc.font(font).fontSize(fontSize).fillColor(color);
      cells.forEach((c, i) => {
        doc.text(c, x + pad, y + pad, { width: widths[i] - pad * 2 });
        x += widths[i];
      });
      return y + h;
    };
    const header = report.columns.map((c) => c.label);
    const drawHeader = (y) => drawRow(header, y, { font: 'Helvetica-Bold', fill: PDF_BRAND, color: '#FFFFFF' });

    doc.font('Helvetica-Bold').fontSize(15).fillColor(PDF_BRAND).text(report.title, PDF_MARGIN, PDF_MARGIN);
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Period: ${report.from} to ${report.to}    Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    let y = drawHeader(doc.y + 8);

    if (!report.rows.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#333333').text('No data for this period.', PDF_MARGIN, y + 10);
    }
    report.rows.forEach((r, i) => {
      const cells = report.columns.map((c) => text(r[c.key]));
      if (y + rowHeight(cells, 'Helvetica') > bottom) {
        doc.addPage();
        y = drawHeader(PDF_MARGIN);
      }
      y = drawRow(cells, y, { font: 'Helvetica', fill: i % 2 ? '#F2F7FC' : null, color: '#222222' });
    });
    if (report.truncated) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#555555').text(`Only the first ${report.rows.length} rows are included. Narrow the dates for the rest.`, PDF_MARGIN, y + 6);
    }

    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.font('Helvetica').fontSize(8).fillColor('#888888').text(`Mio Doctors · Page ${p + 1} of ${range.count}`, PDF_MARGIN, doc.page.height - PDF_MARGIN, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ---- Excel ----------------------------------------------------------------------------

/**
 * Real .xlsx: title + period, bold frozen header with filters, numbers kept
 * as numbers. Text is written as plain string cells, which Excel never runs
 * as formulas, so no CSV-style escaping is needed here.
 */
export async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mio Doctors';
  wb.created = new Date();
  // Sheet names: max 31 chars, none of \ / ? * [ ] :
  const ws = wb.addWorksheet(report.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));

  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([`Period: ${report.from} to ${report.to}`, '', `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]);
  ws.addRow([]);
  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0864AC' } };
  });
  for (const row of report.rows) {
    ws.addRow(report.columns.map((c) => {
      const v = row[c.key];
      return typeof v === 'number' ? v : v === null || v === undefined ? '' : String(v);
    }));
  }
  if (report.truncated) ws.addRow([`Only the first ${report.rows.length} rows are included. Narrow the dates for the rest.`]);

  const headerRow = header.number;
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  if (report.rows.length) {
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + report.rows.length, column: report.columns.length } };
  }
  report.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...report.rows.map((r) => String(r[c.key] ?? '').length));
    ws.getColumn(i + 1).width = Math.min(Math.max(longest + 2, 10), 50);
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
