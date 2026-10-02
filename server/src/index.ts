import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { authenticate, requireStaff } from './lib/auth.js';
import { errorHandler } from './lib/errors.js';
import { scheduleJobs } from './jobs/renewals.js';
import { authRouter } from './modules/auth/routes.js';
import { membersRouter } from './modules/members/routes.js';
import { membershipsRouter, plansRouter } from './modules/memberships/routes.js';
import { invoicesRouter, paymentsRouter } from './modules/billing/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { commonRouter } from './modules/common/routes.js';
import { appRouter } from './modules/app/routes.js';
import { leadsRouter } from './modules/crm/leads.js';
import { communicationsRouter, followUpsRouter, templatesRouter } from './modules/crm/engagement.js';
import { segmentsRouter } from './modules/crm/segments.js';
import { attendanceRouter } from './modules/ops/attendance.js';
import { classesRouter } from './modules/ops/classes.js';
import { appointmentsRouter, ptRouter } from './modules/ops/appointments.js';
import { fitnessRouter } from './modules/fitness/routes.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/me', authenticate, appRouter);

const staff = express.Router();
staff.use(authenticate, requireStaff);
staff.use('/members', membersRouter);
staff.use('/plans', plansRouter);
staff.use('/memberships', membershipsRouter);
staff.use('/payments', paymentsRouter);
staff.use('/invoices', invoicesRouter);
staff.use('/dashboard', dashboardRouter);
staff.use('/admin', adminRouter);
staff.use('/leads', leadsRouter);
staff.use('/follow-ups', followUpsRouter);
staff.use('/communications', communicationsRouter);
staff.use('/templates', templatesRouter);
staff.use('/segments', segmentsRouter);
staff.use('/attendance', attendanceRouter);
staff.use('/classes', classesRouter);
staff.use('/appointments', appointmentsRouter);
staff.use('/pt', ptRouter);
staff.use('/fitness', fitnessRouter);
staff.use('/', commonRouter);
app.use('/api', staff);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found' } });
});
app.use(errorHandler);

await migrate();
scheduleJobs();
app.listen(config.port, () => console.log(`Forge API listening on :${config.port}`));
