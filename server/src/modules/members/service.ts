import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one } from '../../db/pool.js';
import { assertBranch, auth, hashPassword, temporaryPassword } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { isoDate, uuid } from '../../lib/http.js';
import { nextSequence, PAYMENT_METHODS } from '../billing/service.js';
import { sellMembership } from '../memberships/service.js';

export const profileFields = {
  fullName: z.string().trim().min(2),
  email: z.string().trim().email().toLowerCase().optional().nullable(),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number')),
  dateOfBirth: isoDate.optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  address: z.string().trim().optional().nullable(),
  emergencyContactName: z.string().trim().optional().nullable(),
  emergencyContactPhone: z.string().trim().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  assignedStaffId: uuid.optional().nullable(),
};

export const memberCreateSchema = z.object({
  ...profileFields,
  branchId: uuid,
  joinDate: isoDate.optional(),
  issueAppAccess: z.boolean().default(true),
  membership: z
    .object({
      planId: uuid,
      startDate: isoDate.optional(),
      discount: z.coerce.number().min(0).default(0),
      payment: z
        .object({
          amount: z.coerce.number().positive(),
          method: z.enum(PAYMENT_METHODS),
          reference: z.string().trim().optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

/** Registers a member: one user identity + member profile, optional app credentials and first membership sale. */
export async function createMember(c: PoolClient, req: Request, body: MemberCreateInput) {
  assertBranch(req, body.branchId);
  if (body.membership && !auth(req).permissions.has('memberships.manage')) throw badRequest('You cannot sell memberships');
  if (body.membership?.payment && !auth(req).permissions.has('payments.create')) throw badRequest('You cannot record payments');

  const orgId = auth(req).orgId;
  const tempPassword = body.issueAppAccess ? temporaryPassword() : null;
  const user = await one(
    `INSERT INTO users (organization_id, kind, full_name, email, phone, password_hash, must_change_password)
     VALUES ($1,'member',$2,$3,$4,$5,true) RETURNING id`,
    [orgId, body.fullName, body.email ?? null, body.phone, tempPassword ? await hashPassword(tempPassword) : null],
    c,
  );
  const seq = await nextSequence(c, orgId, 'member');
  const memberCode = `M${String(10000 + seq)}`;
  const member = await one(
    `INSERT INTO members (user_id, organization_id, branch_id, member_code, date_of_birth, gender, address,
                          emergency_contact_name, emergency_contact_phone, join_date, source, notes, assigned_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, current_date),$11,$12,$13) RETURNING *`,
    [user!.id, orgId, body.branchId, memberCode, body.dateOfBirth ?? null, body.gender ?? null, body.address ?? null,
      body.emergencyContactName ?? null, body.emergencyContactPhone ?? null, body.joinDate ?? null, body.source ?? null,
      body.notes ?? null, body.assignedStaffId ?? null],
    c,
  );
  await audit(c, req, {
    action: 'member.created',
    entityType: 'member',
    entityId: member.id,
    branchId: body.branchId,
    summary: `New member ${body.fullName} (${memberCode}) registered`,
    after: { member_code: memberCode, phone: body.phone, email: body.email, app_access: body.issueAppAccess },
  });
  let sale = null;
  if (body.membership) sale = await sellMembership(c, req, member.id, { ...body.membership, kind: 'new' });
  return {
    member,
    sale,
    credentials: tempPassword ? { login: body.email ?? body.phone, temporaryPassword: tempPassword } : null,
  };
}
