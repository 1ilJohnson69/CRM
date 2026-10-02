import type { Request } from 'express';
import { pool, type Db } from '../db/pool.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(db: Db, req: Request, entry: AuditEntry) {
  await db.query(
    `INSERT INTO audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, summary, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      req.auth!.orgId,
      entry.branchId ?? null,
      req.auth!.userId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.summary,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      req.ip ?? null,
    ],
  );
}

export interface NotificationInput {
  orgId: string;
  branchId?: string | null;
  recipientId?: string | null;
  audience?: 'staff' | 'member';
  type: string;
  priority?: 'low' | 'normal' | 'high';
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}

export async function notify(db: Db = pool, n: NotificationInput) {
  await db.query(
    `INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, priority, title, body, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [n.orgId, n.branchId ?? null, n.recipientId ?? null, n.audience ?? 'staff', n.type, n.priority ?? 'normal', n.title, n.body ?? null, n.entityType ?? null, n.entityId ?? null],
  );
}
