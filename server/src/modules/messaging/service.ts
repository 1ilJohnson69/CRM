import { config } from '../../config.js';
import { one, pool, query, type Db } from '../../db/pool.js';
import { notify } from '../../lib/audit.js';

export const CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];
type GatewayChannel = Exclude<Channel, 'push'>;

/** Push is delivered in-app (Member App notification centre); the rest need a gateway. */
export function channelStatus(channel: Channel) {
  if (channel === 'push') return { channel, connected: true, mode: 'in_app' as const, provider: 'Forge Member App' };
  const g = config.messaging[channel];
  return { channel, connected: !!g.url, mode: g.url ? ('gateway' as const) : ('manual' as const), provider: g.url ? g.name ?? 'HTTPS gateway' : null };
}

const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '';
  const date = typeof d === 'string' && d.length === 10 ? new Date(`${d}T00:00:00Z`) : new Date(d);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
export const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => vars[k] ?? '');

export const PLACEHOLDERS = ['first_name', 'full_name', 'member_code', 'plan', 'expiry_date', 'days_left', 'amount_due', 'gym', 'branch', 'branch_phone', 'referral_code', 'points', 'offer_code', 'offer_valid_until', 'event_title', 'event_date'] as const;

/** Everything a template can mention about one member or lead. */
export async function subjectVars(db: Db, s: { memberId?: string | null; leadId?: string | null }, extra: Record<string, string> = {}) {
  const row = s.memberId
    ? await one(
      `SELECT m.id, m.branch_id, m.user_id, m.member_code, m.referral_code, m.marketing_opt_out, u.full_name, u.phone, u.email,
              cm.plan_name, cm.end_date, cm.days_remaining, bal.outstanding, l.balance AS points, o.name AS gym, b.name AS branch, b.phone AS branch_phone
         FROM members m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id JOIN branches b ON b.id = m.branch_id
         JOIN member_current_membership cm ON cm.member_id = m.id JOIN member_balances bal ON bal.member_id = m.id JOIN member_loyalty l ON l.member_id = m.id
        WHERE m.id = $1`,
      [s.memberId],
      db,
    )
    : await one(
      `SELECT l.id, l.branch_id, NULL AS user_id, l.full_name, l.phone, l.email, l.marketing_opt_out, p.name AS plan_name, o.name AS gym, b.name AS branch, b.phone AS branch_phone
         FROM leads l JOIN organizations o ON o.id = l.organization_id JOIN branches b ON b.id = l.branch_id LEFT JOIN membership_plans p ON p.id = l.interested_plan_id
        WHERE l.id = $1`,
      [s.leadId],
      db,
    );
  if (!row) return null;
  const vars: Record<string, string> = {
    first_name: row.full_name.split(' ')[0],
    full_name: row.full_name,
    member_code: row.member_code ?? '',
    plan: row.plan_name ?? 'membership',
    expiry_date: fmtDate(row.end_date),
    days_left: row.days_remaining != null ? String(row.days_remaining) : '',
    amount_due: row.outstanding != null ? `₹${Number(row.outstanding).toLocaleString('en-IN')}` : '',
    gym: row.gym,
    branch: row.branch,
    branch_phone: row.branch_phone ?? '',
    referral_code: row.referral_code ?? '',
    points: row.points != null ? Number(row.points).toLocaleString('en-IN') : '',
    ...extra,
  };
  return { row, vars };
}

export interface OutgoingMessage {
  orgId: string;
  memberId?: string | null;
  leadId?: string | null;
  channel: Channel;
  subject?: string | null;
  body: string;
  templateKey?: string | null;
  campaignId?: string | null;
  ruleId?: string | null;
  promotional?: boolean;
  loggedBy?: string | null;
  /** Already-rendered subject/body; otherwise rendered against the recipient. */
  rendered?: boolean;
  extraVars?: Record<string, string>;
}

/**
 * Queues one message. Push is delivered immediately to the Member App;
 * WhatsApp/SMS/email are queued for the dispatcher (or for staff to send by
 * hand when no gateway is connected). Returns why a message was skipped.
 */
export async function enqueueMessage(c: Db, m: OutgoingMessage): Promise<{ status: 'queued' | 'delivered' | 'skipped'; reason?: string; logId?: string }> {
  const subj = await subjectVars(c, m, m.extraVars);
  if (!subj) return { status: 'skipped', reason: 'Not found' };
  const { row, vars } = subj;
  if (m.promotional && row.marketing_opt_out) return { status: 'skipped', reason: 'Opted out of promotions' };
  const recipient = m.channel === 'email' ? row.email : m.channel === 'push' ? row.user_id : row.phone;
  if (!recipient) return { status: 'skipped', reason: m.channel === 'email' ? 'No email address' : m.channel === 'push' ? 'Leads have no app' : 'No phone number' };
  const body = m.rendered ? m.body : render(m.body, vars);
  const subject = m.subject ? (m.rendered ? m.subject : render(m.subject, vars)) : null;
  const status = m.channel === 'push' ? 'delivered' : 'queued';
  const log = await one(
    `INSERT INTO communication_logs (organization_id, branch_id, lead_id, member_id, channel, direction, template_key, subject, body, status, provider,
                                     recipient, campaign_id, automation_rule_id, promotional, logged_by, sent_at)
     VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $9 = 'delivered' THEN now() END) RETURNING id`,
    [m.orgId, row.branch_id, m.leadId ?? null, m.memberId ?? null, m.channel, m.templateKey ?? null, subject, body, status,
      channelStatus(m.channel).connected ? channelStatus(m.channel).provider : 'manual',
      m.channel === 'push' ? 'app' : recipient, m.campaignId ?? null, m.ruleId ?? null, !!m.promotional, m.loggedBy ?? null],
    c,
  );
  if (m.channel === 'push') {
    await notify(c, {
      orgId: m.orgId, branchId: row.branch_id, recipientId: row.user_id, audience: 'member', type: m.campaignId ? 'campaign' : 'message',
      title: subject || vars.gym, body, entityType: m.campaignId ? 'campaign' : 'communication', entityId: m.campaignId ?? log!.id,
    });
  }
  return { status, logId: log!.id };
}

function inQuietHours(settings: { quietStart?: number; quietEnd?: number }) {
  const hour = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' })) % 24;
  const { quietStart = 21, quietEnd = 8 } = settings;
  return quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
}

async function post(channel: GatewayChannel, msg: { id: string; recipient: string; subject: string | null; body: string }) {
  const g = config.messaging[channel];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(g.url!, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(g.token ? { Authorization: `Bearer ${g.token}` } : {}) },
      body: JSON.stringify({ channel, to: msg.recipient, subject: msg.subject, body: msg.body, reference: msg.id }),
    });
    if (!res.ok) throw new Error(`Gateway responded ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { externalId: typeof data?.id === 'string' ? data.id : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends queued messages for channels with a connected gateway. Promotional
 * messages wait out the organisation's quiet hours; failures retry 3 times.
 */
export async function dispatchOutbox() {
  const connected = (['whatsapp', 'sms', 'email'] as const).filter((ch) => config.messaging[ch].url);
  if (!connected.length) return 0;
  const orgs = await query(`SELECT id, messaging_settings FROM organizations`);
  const quiet = new Set(orgs.filter((o) => inQuietHours(o.messaging_settings ?? {})).map((o) => o.id));
  const batch = await query(
    `UPDATE communication_logs SET attempts = attempts + 1
      WHERE id IN (SELECT id FROM communication_logs WHERE status = 'queued' AND channel = ANY($1) AND attempts < 3
                     AND NOT (promotional AND organization_id = ANY($2)) ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
      RETURNING id, channel, recipient, subject, body, attempts`,
    [connected, [...quiet]],
  );
  for (const m of batch) {
    try {
      const r = await post(m.channel, m);
      await pool.query(`UPDATE communication_logs SET status = 'sent', sent_at = now(), external_id = $2, error = NULL WHERE id = $1`, [m.id, r.externalId]);
      await pool.query(`UPDATE campaign_recipients SET status = 'sent' WHERE communication_log_id = $1`, [m.id]);
    } catch (err: any) {
      const failed = m.attempts >= 3;
      await pool.query(`UPDATE communication_logs SET status = $3, error = $2 WHERE id = $1`, [m.id, String(err?.message ?? err).slice(0, 300), failed ? 'failed' : 'queued']);
      if (failed) await pool.query(`UPDATE campaign_recipients SET status = 'failed' WHERE communication_log_id = $1`, [m.id]);
    }
  }
  return batch.length;
}
