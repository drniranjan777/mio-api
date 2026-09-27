import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.js';
import { doctorCards } from '../doctors/doctors.service.js';
import { User } from '../users/user.model.js';
import { MCL_LIMIT, McLEntry } from './mcl.model.js';

export async function listMcl(mr) {
  const rows = await McLEntry.find({ mr: mr._id }).sort({ createdAt: -1 }).select('doctor').lean();
  return doctorCards(rows.map((r) => r.doctor), mr._id);
}

export async function addToMcl(mr, doctorId, req) {
  const doctor = await User.exists({ _id: doctorId, role: 'doctor', status: 'active' });
  if (!doctor) throw ApiError.notFound('Doctor not found', 'DOCTOR_NOT_FOUND');
  if (await McLEntry.exists({ mr: mr._id, doctor: doctorId })) return { doctorId, inMcl: true };
  if ((await McLEntry.countDocuments({ mr: mr._id })) >= MCL_LIMIT) {
    throw ApiError.unprocessable(`My MCL can hold up to ${MCL_LIMIT} doctors`, 'MCL_FULL');
  }
  try {
    await McLEntry.create({ mr: mr._id, doctor: doctorId });
  } catch (err) {
    if (err?.code !== 11000) throw err; // a parallel add already did it
  }
  await audit({ actor: mr, action: 'mcl.added', module: 'mcl', entityType: 'User', entityId: doctorId, req });
  return { doctorId, inMcl: true };
}

export async function removeFromMcl(mr, doctorId, req) {
  const res = await McLEntry.deleteOne({ mr: mr._id, doctor: doctorId });
  if (res.deletedCount) {
    await audit({ actor: mr, action: 'mcl.removed', module: 'mcl', entityType: 'User', entityId: doctorId, req });
  }
  return { doctorId, inMcl: false };
}
