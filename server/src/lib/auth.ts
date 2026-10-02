import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Request } from 'express';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { forbidden, unauthorized } from './errors.js';
import type { Permission } from './permissions.js';

export interface AuthContext {
  userId: string;
  orgId: string;
  kind: 'staff' | 'member';
  fullName: string;
  roleKey: string | null;
  permissions: Set<string>;
  allBranches: boolean;
  branchIds: string[];
  memberId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export function signAccessToken(userId: string, orgId: string) {
  return jwt.sign({ sub: userId, org: orgId }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl as jwt.SignOptions['expiresIn'],
  });
}

export function newRefreshToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// Human-friendly temporary password handed to a member at the desk.
export function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export async function loadAuthContext(userId: string): Promise<AuthContext | null> {
  const user = await one(
    `SELECT u.id, u.organization_id, u.kind, u.full_name, u.is_active,
            r.key AS role_key, COALESCE(r.all_branches, false) AS all_branches,
            m.id AS member_id, m.branch_id AS member_branch_id
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN members m ON m.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  if (!user || !user.is_active) return null;

  let permissions: string[] = [];
  let branchIds: string[] = [];
  if (user.kind === 'staff') {
    permissions = (
      await query(
        `SELECT rp.permission_key FROM role_permissions rp JOIN users u ON u.role_id = rp.role_id WHERE u.id = $1`,
        [userId],
      )
    ).map((r) => r.permission_key);
    branchIds = user.all_branches
      ? (await query(`SELECT id FROM branches WHERE organization_id = $1`, [user.organization_id])).map((r) => r.id)
      : (await query(`SELECT branch_id FROM staff_branches WHERE user_id = $1`, [userId])).map((r) => r.branch_id);
  } else if (user.member_branch_id) {
    branchIds = [user.member_branch_id];
  }

  return {
    userId: user.id,
    orgId: user.organization_id,
    kind: user.kind,
    fullName: user.full_name,
    roleKey: user.role_key,
    permissions: new Set(permissions),
    allBranches: user.all_branches,
    branchIds,
    memberId: user.member_id,
  };
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), config.jwtSecret) as jwt.JwtPayload;
  } catch {
    throw unauthorized('Session expired');
  }
  const ctx = await loadAuthContext(String(payload.sub));
  if (!ctx) throw unauthorized('Account is inactive');
  req.auth = ctx;
  next();
};

export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export const requireStaff: RequestHandler = (req, _res, next) => {
  if (auth(req).kind !== 'staff') throw forbidden();
  next();
};

export const requireMember: RequestHandler = (req, _res, next) => {
  if (!auth(req).memberId) throw forbidden('This endpoint is only available to members');
  next();
};

export function can(...perms: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const ctx = auth(req);
    if (ctx.kind !== 'staff' || !perms.every((p) => ctx.permissions.has(p))) throw forbidden();
    next();
  };
}

/**
 * Branches the current request may touch. Honors the optional X-Branch-Id
 * header (the branch selector in the CRM) but never widens beyond the
 * staff member's assigned branches.
 */
export function branchScope(req: Request): string[] {
  const ctx = auth(req);
  const selected = req.header('x-branch-id');
  if (selected && selected !== 'all') {
    if (!ctx.branchIds.includes(selected)) throw forbidden('You do not have access to that branch');
    return [selected];
  }
  return ctx.branchIds;
}

export function assertBranch(req: Request, branchId: string) {
  if (!auth(req).branchIds.includes(branchId)) throw forbidden('You do not have access to that branch');
}
