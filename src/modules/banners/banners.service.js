import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { dayBounds, localParts } from '../appointments/schedule.js';
import { audit } from '../audit/audit.js';
import { Location } from '../locations/location.model.js';
import { resolveDoctorLocation } from '../locations/locations.service.js';
import { DoctorProfile } from '../profiles/profile.models.js';
import { deleteImage, imageExists, isUploadKey, isVideoKey, publicUrl } from '../uploads/storage.service.js';
import { BANNER_GENDERS, Banner, INTERNAL_TARGETS, LOCATION_CLASSES } from './banner.model.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Status & schedule -----------------------------------------------------------

/** draft / inactive as stored; active splits into scheduled / live / expired by the clock. */
export function effectiveStatus(b, now = new Date()) {
  if (b.status !== 'active') return b.status;
  if (b.startAt && b.startAt > now) return 'scheduled';
  if (b.endAt && b.endAt < now) return 'expired';
  return 'active';
}

/** Mongo filter for an effective status (mirrors effectiveStatus). */
function statusFilter(status, now = new Date()) {
  switch (status) {
    case 'draft':
    case 'inactive':
      return { status };
    case 'scheduled':
      return { status: 'active', startAt: { $gt: now } };
    case 'expired':
      return { status: 'active', endAt: { $lt: now } };
    case 'active':
      return liveFilter(now);
    default:
      return {};
  }
}

/** Banners a doctor may see right now, ignoring location. */
function liveFilter(now = new Date()) {
  return {
    status: 'active',
    $and: [{ $or: [{ startAt: null }, { startAt: { $lte: now } }] }, { $or: [{ endAt: null }, { endAt: { $gte: now } }] }],
  };
}

/** Stored instant → local "YYYY-MM-DD". */
const isoOf = (date) => (date ? localParts(date).dateStr : null);
const startOf = (iso) => (iso ? dayBounds(iso).start : null);
// Inclusive end: the whole end day counts (dayBounds().end is the next midnight).
const endOf = (iso) => (iso ? new Date(dayBounds(iso).end.getTime() - 1) : null);

// ---- Presentation --------------------------------------------------------------------

/** Image keys whose files are no longer in storage. */
async function missingImages(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  const exists = await Promise.all(unique.map(imageExists));
  return new Set(unique.filter((_, i) => !exists[i]));
}

async function locationsById(ids) {
  const docs = await Location.find({ _id: { $in: ids } }).select('name type parent status').lean();
  return new Map(docs.map((l) => [l._id.toString(), l]));
}

function presentAdmin(b, locs, missing, now = new Date()) {
  return {
    id: b._id.toString(),
    title: b.title,
    description: b.description ?? '',
    imageKey: b.imageKey,
    imageUrl: publicUrl(b.imageKey),
    /** File gone from storage → the app skips this banner until a new image is uploaded. */
    imageMissing: missing.has(b.imageKey),
    mobileImageKey: b.mobileImageKey ?? null,
    mobileImageUrl: publicUrl(b.mobileImageKey),
    mediaType: b.mediaType ?? 'image',
    videoKey: b.videoKey ?? null,
    videoUrl: publicUrl(b.videoKey),
    videoMissing: Boolean(b.videoKey && missing.has(b.videoKey)),
    specialties: b.specialties ?? [],
    genders: b.genders ?? [],
    locationClasses: b.locationClasses ?? [],
    showText: Boolean(b.showText),
    redirectType: b.redirectType,
    redirectTarget: b.redirectTarget ?? null,
    targeting: b.targeting,
    locations: (b.locations ?? []).map((id) => {
      const l = locs.get(id.toString());
      return l ? { id: l._id.toString(), name: l.name, type: l.type, status: l.status } : { id: id.toString(), name: 'Removed location', type: null, status: 'inactive' };
    }),
    status: b.status,
    effectiveStatus: effectiveStatus(b, now),
    startDate: isoOf(b.startAt),
    endDate: isoOf(b.endAt),
    priority: b.priority,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// ---- Admin -----------------------------------------------------------------------------

const SORTS = {
  priority: { priority: 1, createdAt: -1 },
  newest: { createdAt: -1 },
  start: { startAt: 1, priority: 1 },
  title: { title: 1 },
};

export async function listBanners(query) {
  const now = new Date();
  const filter = { ...statusFilter(query.status, now) };
  if (query.q) filter.title = new RegExp(escapeRegex(query.q), 'i');
  if (query.locationId === 'all') filter.targeting = 'all';
  else if (query.locationId) filter.locations = query.locationId;
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    Banner.find(filter).sort(SORTS[query.sort] ?? SORTS.priority).skip(skip).limit(limit).lean(),
    Banner.countDocuments(filter),
  ]);
  const [locs, missing] = await Promise.all([
    locationsById(items.flatMap((b) => b.locations ?? [])),
    missingImages(items.flatMap((b) => [b.imageKey, b.videoKey])),
  ]);
  return { items: items.map((b) => presentAdmin(b, locs, missing, now)), meta: meta(total) };
}

async function loadBanner(id) {
  const b = await Banner.findById(id);
  if (!b) throw ApiError.notFound('Banner not found', 'BANNER_NOT_FOUND');
  return b;
}

export async function getBanner(id) {
  const b = (await loadBanner(id)).toObject();
  const [locs, missing] = await Promise.all([locationsById(b.locations), missingImages([b.imageKey, b.videoKey])]);
  return presentAdmin(b, locs, missing);
}

/** Location rules per targeting mode; returns the de-duplicated ids. */
async function checkTargeting(targeting, ids = []) {
  const unique = [...new Set(ids.map(String))];
  if (targeting === 'all') return [];
  if (!unique.length) throw ApiError.badRequest('Pick at least one location', [{ path: 'locationIds', message: 'Required' }], 'VALIDATION_ERROR');
  const docs = await Location.find({ _id: { $in: unique } }).select('type status').lean();
  if (docs.length !== unique.length) throw ApiError.badRequest('One or more locations were not found', [{ path: 'locationIds', message: 'Unknown location' }], 'VALIDATION_ERROR');
  if (docs.some((d) => d.status !== 'active')) throw ApiError.badRequest('Inactive locations cannot be targeted', [{ path: 'locationIds', message: 'Inactive location' }], 'VALIDATION_ERROR');
  const want = { state: 'state', city: 'city' }[targeting];
  if (want && (unique.length !== 1 || docs[0].type !== want)) {
    throw ApiError.badRequest(`Pick exactly one ${want}`, [{ path: 'locationIds', message: `One ${want}` }], 'VALIDATION_ERROR');
  }
  if (targeting === 'multiple' && docs.some((d) => d.type === 'country')) {
    throw ApiError.badRequest('Use "All locations" instead of the whole country', [{ path: 'locationIds', message: 'Country not allowed' }], 'VALIDATION_ERROR');
  }
  return unique;
}

async function checkImage(key, path) {
  if (!key) return;
  if (!isUploadKey(key) || !(await imageExists(key))) {
    throw ApiError.badRequest('The image was not found — upload it again', [{ path, message: 'Missing image' }], 'VALIDATION_ERROR');
  }
}

async function checkVideo(key) {
  if (!isVideoKey(key) || !(await imageExists(key))) {
    throw ApiError.badRequest('The video was not found — upload it again', [{ path: 'videoKey', message: 'Missing video' }], 'VALIDATION_ERROR');
  }
}

/** Trimmed, de-duplicated specialty names (case-insensitive). */
function cleanSpecialties(list = []) {
  const seen = new Map();
  for (const s of list) {
    const v = s.trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

function checkRedirect(type, target) {
  if (type === 'none') return undefined;
  if (type === 'internal') {
    if (!INTERNAL_TARGETS.some((t) => t.key === target)) {
      throw ApiError.badRequest('Choose an app screen', [{ path: 'redirectTarget', message: 'Unknown screen' }], 'VALIDATION_ERROR');
    }
    return target;
  }
  // external: validated as https URL by the route schema
  return target;
}

function checkDates(start, end) {
  if (start && end && end < start) {
    throw ApiError.badRequest('End date must be on or after the start date', [{ path: 'endDate', message: 'Before start date' }], 'VALIDATION_ERROR');
  }
}

export async function createBanner(admin, body, req) {
  const video = body.mediaType === 'video';
  await Promise.all([
    checkImage(body.imageKey, 'imageKey'),
    checkImage(body.mobileImageKey, 'mobileImageKey'),
    video ? checkVideo(body.videoKey) : null,
  ]);
  checkDates(body.startDate, body.endDate);
  const banner = await Banner.create({
    title: body.title,
    description: body.description,
    imageKey: body.imageKey,
    mobileImageKey: body.mobileImageKey,
    mediaType: body.mediaType,
    videoKey: video ? body.videoKey : undefined,
    specialties: cleanSpecialties(body.specialties),
    genders: body.genders,
    locationClasses: body.locationClasses,
    showText: body.showText,
    redirectType: body.redirectType,
    redirectTarget: checkRedirect(body.redirectType, body.redirectTarget),
    targeting: body.targeting,
    locations: await checkTargeting(body.targeting, body.locationIds),
    status: body.status,
    startAt: startOf(body.startDate),
    endAt: endOf(body.endDate),
    priority: body.priority,
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  await audit({ actor: admin, action: 'banner.created', module: 'banners', entityType: 'Banner', entityId: banner._id, after: { title: banner.title, targeting: banner.targeting, status: banner.status }, req });
  return getBanner(banner._id);
}

export async function updateBanner(admin, id, body, req) {
  const b = await loadBanner(id);
  const before = { title: b.title, status: b.status, targeting: b.targeting, locations: b.locations.map(String), priority: b.priority };
  const oldFiles = [b.imageKey, b.mobileImageKey, b.videoKey];

  if (body.imageKey !== undefined) await checkImage(body.imageKey, 'imageKey');
  if (body.mobileImageKey) await checkImage(body.mobileImageKey, 'mobileImageKey');
  if (body.videoKey) await checkVideo(body.videoKey);

  const mediaType = body.mediaType ?? b.mediaType ?? 'image';
  const videoKey = mediaType === 'video' ? (body.videoKey ?? b.videoKey) : undefined;
  if (mediaType === 'video' && !videoKey) {
    throw ApiError.badRequest('Upload the video', [{ path: 'videoKey', message: 'Required for a video banner' }], 'VALIDATION_ERROR');
  }
  b.mediaType = mediaType;
  b.videoKey = videoKey;
  if (body.specialties !== undefined) b.specialties = cleanSpecialties(body.specialties);
  if (body.genders !== undefined) b.genders = body.genders;
  if (body.locationClasses !== undefined) b.locationClasses = body.locationClasses;

  const start = body.startDate !== undefined ? body.startDate : isoOf(b.startAt);
  const end = body.endDate !== undefined ? body.endDate : isoOf(b.endAt);
  checkDates(start, end);

  const targeting = body.targeting ?? b.targeting;
  if (body.targeting !== undefined || body.locationIds !== undefined) {
    b.locations = await checkTargeting(targeting, body.locationIds ?? b.locations);
    b.targeting = targeting;
  }
  const redirectType = body.redirectType ?? b.redirectType;
  if (body.redirectType !== undefined || body.redirectTarget !== undefined) {
    b.redirectType = redirectType;
    b.redirectTarget = checkRedirect(redirectType, body.redirectTarget ?? b.redirectTarget);
  }
  for (const k of ['title', 'description', 'imageKey', 'showText', 'status', 'priority']) if (body[k] !== undefined) b[k] = body[k];
  if (body.mobileImageKey !== undefined) b.mobileImageKey = body.mobileImageKey || undefined;
  if (body.startDate !== undefined) b.startAt = startOf(body.startDate);
  if (body.endDate !== undefined) b.endAt = endOf(body.endDate);
  b.updatedBy = admin._id;
  await b.save();

  // Replaced files are no longer referenced by this banner.
  for (const key of oldFiles) if (key && ![b.imageKey, b.mobileImageKey, b.videoKey].includes(key)) await deleteImage(key);
  await audit({ actor: admin, action: 'banner.updated', module: 'banners', entityType: 'Banner', entityId: b._id, before, after: body, req });
  return getBanner(b._id);
}

export async function setBannerStatus(admin, id, status, req) {
  const b = await loadBanner(id);
  const before = b.status;
  b.status = status;
  b.updatedBy = admin._id;
  await b.save();
  await audit({ actor: admin, action: `banner.${status === 'active' ? 'activated' : status === 'inactive' ? 'deactivated' : 'set_draft'}`, module: 'banners', entityType: 'Banner', entityId: b._id, before: { status: before }, after: { status }, req });
  return getBanner(b._id);
}

export async function deleteBanner(admin, id, req) {
  const b = await loadBanner(id);
  await b.deleteOne();
  await Promise.all([deleteImage(b.imageKey), deleteImage(b.mobileImageKey), deleteImage(b.videoKey)]);
  await audit({ actor: admin, action: 'banner.deleted', module: 'banners', entityType: 'Banner', entityId: b._id, before: { title: b.title }, req });
}

/** Offered even before any doctor of that specialty has registered. */
const DEFAULT_SPECIALTIES = [
  'General Physician',
  'Cardiology',
  'Neurology',
  'Dermatology',
  'Diabetology',
  'Gynecology',
  'Orthopedics',
  'Psychiatry',
  'Internal Medicine',
  'Pediatrics',
  'ENT',
  'Ophthalmology',
  'Gastroenterology',
  'Nephrology',
  'Pulmonology',
  'Oncology',
  'Urology',
  'Dentistry',
];

/** Dropdown data for the admin form: app screens + active locations (states with their cities). */
export async function bannerOptions() {
  const locs = await Location.find({ status: 'active', type: { $in: ['state', 'city'] } }).select('name type parent').sort({ name: 1 }).lean();
  const cities = new Map();
  for (const c of locs.filter((l) => l.type === 'city')) {
    const key = c.parent?.toString();
    if (!cities.has(key)) cities.set(key, []);
    cities.get(key).push({ id: c._id.toString(), name: c.name });
  }
  const specialties = await DoctorProfile.distinct('specialty', { specialty: { $type: 'string', $ne: '' } });
  return {
    internalTargets: INTERNAL_TARGETS,
    specialties: cleanSpecialties([...DEFAULT_SPECIALTIES, ...specialties]).sort((a, b) => a.localeCompare(b)),
    genders: BANNER_GENDERS,
    locationClasses: LOCATION_CLASSES,
    states: locs.filter((l) => l.type === 'state').map((s) => ({ id: s._id.toString(), name: s.name, cities: cities.get(s._id.toString()) ?? [] })),
  };
}

// ---- Doctor app --------------------------------------------------------------------------

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Specialty / gender / Metro-class filters. An empty list means "everyone";
 * a doctor whose profile lacks the field only sees banners without that filter.
 */
function matchesAudience(b, profile) {
  if (b.specialties?.length && !b.specialties.some((s) => same(s, profile?.specialty))) return false;
  if (b.genders?.length && !b.genders.includes(profile?.gender)) return false;
  if (b.locationClasses?.length && !b.locationClasses.some((c) => same(c, profile?.practice?.locationType))) return false;
  return true;
}

/** Ranking: city-specific (0) before state-specific (1) before global (2); then priority, then newest. */
const LEVEL = { city: 0, state: 1, all: 2 };

/**
 * Banners for the signed-in doctor. The location always comes from the
 * doctor's saved profile on the server — the app cannot pass one in.
 */
export async function bannersForDoctor(doctor) {
  const profile = await DoctorProfile.findOne({ user: doctor._id })
    .select('specialty gender practice.state practice.city practice.district practice.locationType')
    .lean();
  const { state, city } = await resolveDoctorLocation({ state: profile?.practice?.state, city: profile?.practice?.city, district: profile?.practice?.district });
  const ids = [state?._id, city?._id].filter(Boolean);

  const now = new Date();
  const found = await Banner.find({ ...liveFilter(now), $or: [{ targeting: 'all' }, ...(ids.length ? [{ locations: { $in: ids } }] : [])] })
    .select('title description imageKey mobileImageKey mediaType videoKey specialties genders locationClasses showText redirectType redirectTarget targeting locations priority createdAt')
    .lean();
  const banners = found.filter((b) => matchesAudience(b, profile));

  const missing = await missingImages(banners.flatMap((b) => [b.imageKey, b.mobileImageKey, b.videoKey]));
  return banners
    .filter((b) => isUploadKey(b.imageKey) && !missing.has(b.imageKey))
    .map((b) => {
      // The most specific location of this doctor that the banner targets.
      const match =
        (city && b.locations?.some((l) => l.equals(city._id)) && { level: 'city', loc: city }) ||
        (state && b.locations?.some((l) => l.equals(state._id)) && { level: 'state', loc: state }) ||
        { level: 'all', loc: null };
      return { b, match };
    })
    .sort((x, y) => LEVEL[x.match.level] - LEVEL[y.match.level] || x.b.priority - y.b.priority || y.b.createdAt - x.b.createdAt)
    .map(({ b, match }) => ({
      id: b._id.toString(),
      title: b.title,
      description: b.description ?? null,
      imageUrl: publicUrl(b.imageKey),
      mobileImageUrl: missing.has(b.mobileImageKey) ? null : publicUrl(b.mobileImageKey),
      // A video whose file is gone falls back to its cover image.
      mediaType: b.mediaType === 'video' && b.videoKey && !missing.has(b.videoKey) ? 'video' : 'image',
      videoUrl: b.mediaType === 'video' && b.videoKey && !missing.has(b.videoKey) ? publicUrl(b.videoKey) : null,
      showText: Boolean(b.showText),
      redirectType: b.redirectType,
      redirectTarget: b.redirectType === 'none' ? null : (b.redirectTarget ?? null),
      priority: b.priority,
      location: match.loc ? { type: match.level, name: match.loc.name } : { type: 'all', name: 'All Locations' },
    }));
}
