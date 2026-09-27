import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';

const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    actor: { user: { type: Schema.Types.ObjectId, ref: 'User' }, role: String },
    action: { type: String, required: true },
    module: { type: String, required: true },
    entityType: String,
    entityId: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ 'actor.user': 1, createdAt: -1 });
auditLogSchema.index({ module: 1, action: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

/**
 * Records an audit entry. Failures are logged, never thrown: an audit hiccup
 * must not roll back the user's action.
 */
export async function audit({ actor, action, module, entityType, entityId, before, after, req }) {
  try {
    await AuditLog.create({
      actor: actor ? { user: actor._id ?? actor.id, role: actor.role } : undefined,
      action,
      module,
      entityType,
      entityId: entityId?.toString(),
      before,
      after,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
    });
  } catch (err) {
    logger.error({ err, action, module }, 'Failed to write audit log');
  }
}
