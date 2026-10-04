import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { audit } from '../audit/audit.js';
import { Banner } from '../banners/banner.model.js';
import { Location, locationKey } from './location.model.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const present = (l, parentName) => ({
  id: l._id.toString(),
  name: l.name,
  code: l.code ?? null,
  type: l.type,
  parentId: l.parent?.toString() ?? null,
  parentName: parentName ?? null,
  aliases: l.aliases ?? [],
  status: l.status,
});

/** Admin list (flat, with parent names). Small table → no pagination needed for the picker. */
export async function listLocations(query) {
  const filter = {};
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.parentId) filter.parent = query.parentId;
  if (query.q) filter.keys = new RegExp(escapeRegex(locationKey(query.q)));
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    Location.find(filter).sort({ type: 1, name: 1 }).skip(skip).limit(limit).lean(),
    Location.countDocuments(filter),
  ]);
  const parents = new Map(
    (await Location.find({ _id: { $in: items.map((l) => l.parent).filter(Boolean) } }).select('name').lean()).map((p) => [p._id.toString(), p.name]),
  );
  return { items: items.map((l) => present(l, parents.get(l.parent?.toString()))), meta: meta(total) };
}

async function assertParent(type, parentId) {
  const expected = { country: null, state: 'country', city: 'state' }[type];
  if (!expected) {
    if (parentId) throw ApiError.badRequest('A country has no parent', [{ path: 'parentId', message: 'Not allowed' }], 'VALIDATION_ERROR');
    return null;
  }
  const parent = parentId && (await Location.findById(parentId).lean());
  if (!parent || parent.type !== expected) {
    throw ApiError.badRequest(`Choose the ${expected} this ${type} belongs to`, [{ path: 'parentId', message: `Must be a ${expected}` }], 'VALIDATION_ERROR');
  }
  return parent._id;
}

function duplicate(err) {
  if (err?.code === 11000) throw ApiError.conflict('A location with this name or code already exists here', 'LOCATION_EXISTS');
  throw err;
}

export async function createLocation(admin, body, req) {
  const parent = await assertParent(body.type, body.parentId);
  const loc = await Location.create({ name: body.name, code: body.code, type: body.type, parent, aliases: body.aliases ?? [], status: body.status ?? 'active' }).catch(duplicate);
  await audit({ actor: admin, action: 'location.created', module: 'banners', entityType: 'Location', entityId: loc._id, after: body, req });
  return present(loc);
}

export async function updateLocation(admin, id, body, req) {
  const loc = await Location.findById(id);
  if (!loc) throw ApiError.notFound('Location not found', 'LOCATION_NOT_FOUND');
  const before = { name: loc.name, code: loc.code, aliases: [...loc.aliases], status: loc.status };
  if (body.name !== undefined) loc.name = body.name;
  if (body.code !== undefined) loc.code = body.code || undefined;
  if (body.aliases !== undefined) loc.aliases = body.aliases;
  if (body.status !== undefined) loc.status = body.status;
  await loc.save().catch(duplicate);
  await audit({ actor: admin, action: 'location.updated', module: 'banners', entityType: 'Location', entityId: loc._id, before, after: body, req });
  return present(loc);
}

export async function deleteLocation(admin, id, req) {
  const loc = await Location.findById(id).lean();
  if (!loc) throw ApiError.notFound('Location not found', 'LOCATION_NOT_FOUND');
  const [children, banners] = await Promise.all([Location.countDocuments({ parent: id }), Banner.countDocuments({ locations: id })]);
  if (children) throw ApiError.conflict(`It has ${children} location(s) under it. Remove or move those first, or deactivate it.`, 'LOCATION_HAS_CHILDREN');
  if (banners) throw ApiError.conflict(`${banners} banner(s) target it. Change those banners first, or deactivate it.`, 'LOCATION_IN_USE');
  await Location.deleteOne({ _id: id });
  await audit({ actor: admin, action: 'location.deleted', module: 'banners', entityType: 'Location', entityId: id, before: { name: loc.name, type: loc.type }, req });
}

/**
 * Resolves a doctor's free-text state/city to active location ids.
 * - City match prefers a city under the doctor's state when both are known.
 * - A matched city also yields its state, so a "Hyderabad" doctor without a
 *   state still sees Telangana banners.
 * - Unknown/blank values simply match nothing (global banners still show).
 * - If the city text matches nothing, the district is tried as the city
 *   (doctors often enter a locality as city and the metro as district).
 * Returns `{ state, city }` location docs (either may be null).
 */
export async function resolveDoctorLocation({ state, city, district }) {
  const stateKey = locationKey(state);
  let stateLoc = stateKey ? await Location.findOne({ type: 'state', status: 'active', keys: stateKey }).lean() : null;

  let cityLoc = null;
  for (const cityKey of [locationKey(city), locationKey(district)].filter(Boolean)) {
    const candidates = await Location.find({ type: 'city', status: 'active', keys: cityKey }).lean();
    cityLoc = stateLoc
      ? (candidates.find((c) => c.parent?.equals(stateLoc._id)) ?? null)
      : candidates.length === 1
        ? candidates[0]
        : null; // ambiguous name in several states → no city match
    if (cityLoc) break;
  }
  if (!stateLoc && cityLoc?.parent) {
    stateLoc = await Location.findOne({ _id: cityLoc.parent, status: 'active' }).lean();
  }
  return { state: stateLoc, city: cityLoc };
}
