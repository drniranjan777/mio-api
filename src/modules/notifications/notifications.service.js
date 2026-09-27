import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { Notification } from './notification.model.js';

/**
 * Fans a notification out to users. Like audit(), failures are logged and
 * never thrown — a notification hiccup must not undo the user's action.
 */
export async function notify(userIds, { type, title, body, data }) {
  const ids = [...new Set((userIds ?? []).filter(Boolean).map(String))];
  if (!ids.length) return;
  try {
    await Notification.insertMany(ids.map((user) => ({ user, type, title, body, data })), { ordered: false });
  } catch (err) {
    logger.error({ err, type }, 'Failed to create notifications');
  }
}

const present = (n) => ({
  id: n._id.toString(),
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data ?? {},
  read: Boolean(n.readAt),
  createdAt: n.createdAt,
});

export async function listNotifications(user, query) {
  const filter = { user: user._id };
  if (query.unread) filter.readAt = null;
  const { skip, limit, meta } = paging(query);
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: user._id, readAt: null }),
  ]);
  return { items: items.map(present), meta: { ...meta(total), unread } };
}

export async function unreadCount(user) {
  return { unread: await Notification.countDocuments({ user: user._id, readAt: null }) };
}

export async function markRead(user, id) {
  const n = await Notification.findOneAndUpdate(
    { _id: id, user: user._id },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();
  if (!n) throw ApiError.notFound('Notification not found', 'NOTIFICATION_NOT_FOUND');
  return present(n);
}

export async function markAllRead(user) {
  const res = await Notification.updateMany({ user: user._id, readAt: null }, { $set: { readAt: new Date() } });
  return { updated: res.modifiedCount };
}
