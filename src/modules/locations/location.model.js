import mongoose from 'mongoose';

const { Schema } = mongoose;

export const LOCATION_TYPES = Object.freeze(['country', 'state', 'city']);
export const LOCATION_STATUS = Object.freeze(['active', 'inactive']);

/** "  Bengaluru  " / "BENGALURU" → "bengaluru" (used for matching free-text doctor locations). */
export const locationKey = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Hierarchical locations: India → states → cities. Banners target these by id.
 * `aliases` lets free-text doctor data match ("Bangalore" → Bengaluru).
 */
const locationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, trim: true, uppercase: true, maxlength: 20 },
    type: { type: String, enum: LOCATION_TYPES, required: true },
    parent: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    aliases: [{ type: String, trim: true, maxlength: 80 }],
    /** Normalised name + aliases, maintained on save — what matching reads. */
    keys: [{ type: String }],
    status: { type: String, enum: LOCATION_STATUS, default: 'active' },
  },
  { timestamps: true },
);

locationSchema.pre('validate', function setKeys(next) {
  this.keys = [...new Set([this.name, ...(this.aliases ?? [])].map(locationKey).filter(Boolean))];
  next();
});

// One name per level under the same parent (e.g. no two "Hyderabad" cities in Telangana).
locationSchema.index({ parent: 1, type: 1, keys: 1 });
locationSchema.index({ parent: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
locationSchema.index({ type: 1, status: 1, keys: 1 });
locationSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

export const Location = mongoose.model('Location', locationSchema);
