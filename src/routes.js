import { Router } from 'express';

import { adminRouter } from './modules/admin/admin.routes.js';
import { accessRouter } from './modules/access/access.routes.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { plansRouter, subscriptionsRouter } from './modules/billing/billing.routes.js';
import { birthdaysRouter, wishesRouter } from './modules/birthdays/birthdays.routes.js';
import { conferencesRouter } from './modules/conferences/conferences.routes.js';
import { doctorsRouter } from './modules/doctors/doctors.routes.js';
import { mclRouter } from './modules/mcl/mcl.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { doctorMeRouter, meRouter, mrMeRouter, receptionistMeRouter } from './modules/profiles/profiles.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { rolesRouter, staffRouter } from './modules/staff/staff.routes.js';
import { contentRouter, faqsRouter, supportRouter, ticketsRouter } from './modules/support/support.routes.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/doctors/me/receptionists', accessRouter);
apiRouter.use('/doctors/me', doctorMeRouter);
apiRouter.use('/mrs/me/mcl', mclRouter);
apiRouter.use('/mrs/me', mrMeRouter);
apiRouter.use('/receptionists/me', receptionistMeRouter);
apiRouter.use('/doctors', doctorsRouter);
apiRouter.use('/appointments', appointmentsRouter);
apiRouter.use('/birthdays', birthdaysRouter);
apiRouter.use('/wishes', wishesRouter);
apiRouter.use('/conferences', conferencesRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/plans', plansRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/support', supportRouter);
apiRouter.use('/help-tickets', ticketsRouter);
apiRouter.use('/faqs', faqsRouter);
apiRouter.use('/content', contentRouter);
apiRouter.use('/admin/staff', staffRouter);
apiRouter.use('/admin/roles', rolesRouter);
apiRouter.use('/admin', adminRouter);
