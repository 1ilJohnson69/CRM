import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { one, pool } from '../../db/pool.js';
import {
  auth,
  authenticate,
  hashPassword,
  loadAuthContext,
  newRefreshToken,
  sha256,
  signAccessToken,
  verifyPassword,
} from '../../lib/auth.js';
import { badRequest, unauthorized } from '../../lib/errors.js';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const loginSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
  client: z.enum(['crm', 'app']).default('crm'),
});

async function issueSession(userId: string, orgId: string, client: 'crm' | 'app', userAgent?: string, ip?: string) {
  const refresh = newRefreshToken();
  await pool.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, client, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))`,
    [userId, refresh.hash, client, userAgent ?? null, ip ?? null, config.refreshTokenDays],
  );
  return { accessToken: signAccessToken(userId, orgId), refreshToken: refresh.token };
}

async function profile(userId: string) {
  const ctx = await loadAuthContext(userId);
  if (!ctx) throw unauthorized('Account is inactive');
  const user = await one(
    `SELECT u.id, u.full_name, u.email, u.phone, u.kind, u.avatar_url, u.must_change_password, r.name AS role_name
       FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [userId],
  );
  const branches = await pool.query(`SELECT id, name, code FROM branches WHERE id = ANY($1) ORDER BY name`, [ctx.branchIds]);
  const org = await one(`SELECT id, name, currency, expiring_soon_days FROM organizations WHERE id = $1`, [ctx.orgId]);
  return {
    ...user,
    role_key: ctx.roleKey,
    member_id: ctx.memberId,
    all_branches: ctx.allBranches,
    permissions: [...ctx.permissions],
    branches: branches.rows,
    organization: org,
  };
}

// Staff and members sign in with the same endpoint: the CRM passes
// client=crm and the Member App passes client=app.
authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const id = body.identifier.toLowerCase();
  const user = await one(
    `SELECT id, organization_id, kind, password_hash, is_active FROM users
      WHERE lower(email) = $1 OR phone = $2 LIMIT 1`,
    [id, body.identifier.replace(/[\s-]/g, '')],
  );
  const ok = user?.password_hash && (await verifyPassword(body.password, user.password_hash));
  if (!user || !ok) throw unauthorized('Incorrect email/phone or password');
  if (!user.is_active) throw unauthorized('This account has been deactivated. Please contact the front desk.');
  if (body.client === 'crm' && user.kind !== 'staff') throw unauthorized('Members sign in through the member app');

  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  const tokens = await issueSession(user.id, user.organization_id, body.client, req.get('user-agent'), req.ip);
  res.json({ ...tokens, user: await profile(user.id) });
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  const session = await one(
    `SELECT s.id, s.user_id, s.client, u.organization_id, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(refreshToken)],
  );
  if (!session || !session.is_active) throw unauthorized('Session expired');
  // Rotate: the old refresh token stops working as soon as it is used.
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [session.id]);
  const tokens = await issueSession(session.user_id, session.organization_id, session.client, req.get('user-agent'), req.ip);
  res.json(tokens);
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
  if (refreshToken) await pool.query(`UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1`, [sha256(refreshToken)]);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await profile(auth(req).userId));
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const body = z
    .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Use at least 8 characters') })
    .parse(req.body);
  const user = await one(`SELECT password_hash FROM users WHERE id = $1`, [auth(req).userId]);
  if (!user?.password_hash || !(await verifyPassword(body.currentPassword, user.password_hash))) {
    throw badRequest('Current password is incorrect');
  }
  await pool.query(`UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`, [
    auth(req).userId,
    await hashPassword(body.newPassword),
  ]);
  res.status(204).end();
});
