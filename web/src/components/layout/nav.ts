import {
  Activity, Apple, BarChart3, Building2, CalendarClock, CalendarDays, ClipboardCheck, ClipboardList, Contact, CreditCard, Dumbbell,
  Gift, Handshake, Layers, LayoutDashboard, Megaphone, MessageSquare, Package, PhoneCall, Receipt, ScanLine, ScrollText,
  Settings, ShieldCheck, ShoppingBag, Ticket, Trophy, UserCog, Users, Wallet, type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  perm?: string;
  /** Planned module — shown so the product map is visible, but not linked. */
  phase?: number;
}

export const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, perm: 'dashboard.view' }] },
  {
    group: 'CRM',
    items: [
      { label: 'Members', to: '/members', icon: Users, perm: 'members.read' },
      { label: 'Leads', to: '/leads', icon: Contact, perm: 'leads.read' },
      { label: 'Follow-ups', to: '/follow-ups', icon: PhoneCall, perm: 'followups.manage' },
      { label: 'Segments', to: '/segments', icon: Layers, perm: 'members.read' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { label: 'Memberships', to: '/memberships', icon: Ticket, perm: 'plans.read' },
      { label: 'Personal Training', to: '/pt', icon: Dumbbell, perm: 'appointments.read' },
      { label: 'Classes', to: '/classes', icon: CalendarDays, perm: 'classes.read' },
      { label: 'Events', to: '/events', icon: Trophy, phase: 6 },
    ],
  },
  {
    group: 'Operations',
    items: [
      { label: 'Attendance', to: '/attendance', icon: ScanLine, perm: 'attendance.read' },
      { label: 'Appointments', to: '/appointments', icon: CalendarClock, perm: 'appointments.read' },
      { label: 'Front Desk', to: '/front-desk', icon: ClipboardCheck, perm: 'attendance.checkin' },
      { label: 'POS', to: '/pos', icon: ShoppingBag, phase: 5 },
      { label: 'Inventory', to: '/inventory', icon: Package, phase: 5 },
    ],
  },
  {
    group: 'Fitness',
    items: [
      { label: 'Workouts', to: '/workouts', icon: Activity, phase: 4 },
      { label: 'Nutrition', to: '/nutrition', icon: Apple, phase: 4 },
      { label: 'Assessments', to: '/assessments', icon: ClipboardList, phase: 4 },
    ],
  },
  {
    group: 'Finance',
    items: [
      { label: 'Payments', to: '/payments', icon: CreditCard, perm: 'payments.read' },
      { label: 'Invoices', to: '/invoices', icon: Receipt, perm: 'invoices.read' },
      { label: 'Expenses', to: '/expenses', icon: Wallet, phase: 5 },
    ],
  },
  {
    group: 'Engagement',
    items: [
      { label: 'Loyalty', to: '/loyalty', icon: Gift, phase: 5 },
      { label: 'Referrals', to: '/referrals', icon: Handshake, phase: 5 },
      { label: 'Marketing', to: '/marketing', icon: Megaphone, phase: 6 },
      { label: 'Communication', to: '/communication', icon: MessageSquare, perm: 'communications.log' },
    ],
  },
  { group: 'Insights', items: [{ label: 'Analytics', to: '/analytics', icon: BarChart3, phase: 6 }] },
  {
    group: 'Administration',
    items: [
      { label: 'Employees', to: '/admin/employees', icon: UserCog, perm: 'staff.read' },
      { label: 'Branches', to: '/admin/branches', icon: Building2 },
      { label: 'Roles & Permissions', to: '/admin/roles', icon: ShieldCheck, perm: 'roles.manage' },
      { label: 'Settings', to: '/admin/settings', icon: Settings, perm: 'settings.manage' },
      { label: 'Audit Logs', to: '/admin/audit', icon: ScrollText, perm: 'audit.read' },
    ],
  },
];

export const PHASE_LABEL: Record<number, string> = {
  2: 'Phase 2 · CRM',
  3: 'Phase 3 · Gym operations',
  4: 'Phase 4 · Fitness',
  5: 'Phase 5 · Business',
  6: 'Phase 6 · Advanced',
};

