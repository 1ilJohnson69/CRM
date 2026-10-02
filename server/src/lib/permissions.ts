// Catalog of permission keys. Role → permission assignments live in the
// database and are editable from Roles & Permissions; this list only defines
// what can be granted.
export const PERMISSIONS = [
  { key: 'dashboard.view', module: 'Dashboard', description: 'View the dashboard' },
  { key: 'members.read', module: 'Members', description: 'View members' },
  { key: 'members.write', module: 'Members', description: 'Create and edit members' },
  { key: 'members.credentials', module: 'Members', description: 'Issue and reset member app credentials' },
  { key: 'segments.manage', module: 'Members', description: 'Create and edit member segments' },
  { key: 'leads.read', module: 'Leads', description: 'View leads and the sales pipeline' },
  { key: 'leads.write', module: 'Leads', description: 'Create, edit, move and convert leads' },
  { key: 'followups.manage', module: 'Leads', description: 'Create and complete follow-ups' },
  { key: 'communications.log', module: 'Communication', description: 'Contact members/leads and log communication' },
  { key: 'templates.manage', module: 'Communication', description: 'Edit message templates' },
  { key: 'attendance.read', module: 'Attendance', description: 'View check-ins and attendance analytics' },
  { key: 'attendance.checkin', module: 'Attendance', description: 'Check members in and out' },
  { key: 'attendance.override', module: 'Attendance', description: 'Allow entry despite a membership problem' },
  { key: 'staff.attendance', module: 'Attendance', description: 'Clock staff in and out' },
  { key: 'classes.read', module: 'Classes', description: 'View the class timetable and rosters' },
  { key: 'classes.book', module: 'Classes', description: 'Book and cancel members in classes, mark attendance' },
  { key: 'classes.manage', module: 'Classes', description: 'Create class types, schedules and one-off sessions' },
  { key: 'appointments.read', module: 'Appointments', description: 'View the appointment calendar' },
  { key: 'appointments.manage', module: 'Appointments', description: 'Book, reschedule, complete and cancel appointments' },
  { key: 'pt.sell', module: 'Personal training', description: 'Sell PT packages' },
  { key: 'pt.manage', module: 'Personal training', description: 'Edit PT packages and trainer profiles' },
  { key: 'workouts.read', module: 'Fitness', description: 'View workout plans and the exercise library' },
  { key: 'workouts.manage', module: 'Fitness', description: 'Build and assign workout plans, edit exercises' },
  { key: 'nutrition.read', module: 'Fitness', description: 'View nutrition plans' },
  { key: 'nutrition.manage', module: 'Fitness', description: 'Build and assign nutrition plans' },
  { key: 'assessments.read', module: 'Fitness', description: 'View fitness assessments, progress and photos' },
  { key: 'assessments.manage', module: 'Fitness', description: 'Record assessments and upload progress photos' },
  { key: 'plans.read', module: 'Memberships', description: 'View membership plans' },
  { key: 'plans.manage', module: 'Memberships', description: 'Create and edit membership plans' },
  { key: 'memberships.manage', module: 'Memberships', description: 'Sell, renew, freeze and cancel memberships' },
  { key: 'payments.read', module: 'Finance', description: 'View payments' },
  { key: 'payments.create', module: 'Finance', description: 'Record payments' },
  { key: 'payments.void', module: 'Finance', description: 'Void recorded payments' },
  { key: 'invoices.read', module: 'Finance', description: 'View and print invoices' },
  { key: 'pos.sell', module: 'Sales', description: 'Sell products and services at the point of sale' },
  { key: 'pos.refund', module: 'Sales', description: 'Refund sales and return items' },
  { key: 'inventory.read', module: 'Inventory', description: 'View products, stock levels and stock movements' },
  { key: 'inventory.manage', module: 'Inventory', description: 'Edit products and suppliers, receive and adjust stock' },
  { key: 'expenses.read', module: 'Finance', description: 'View expenses and profit & loss' },
  { key: 'expenses.manage', module: 'Finance', description: 'Record and void expenses' },
  { key: 'loyalty.manage', module: 'Engagement', description: 'Award or adjust loyalty points and edit loyalty rules' },
  { key: 'referrals.manage', module: 'Engagement', description: 'Record, verify and reward referrals' },
  { key: 'events.read', module: 'Events', description: 'View events and participant lists' },
  { key: 'events.manage', module: 'Events', description: 'Create events, register participants and mark attendance' },
  { key: 'marketing.read', module: 'Marketing', description: 'View campaigns and their results' },
  { key: 'marketing.manage', module: 'Marketing', description: 'Create, schedule and send campaigns' },
  { key: 'reports.read', module: 'Analytics', description: 'View revenue and membership analytics' },
  { key: 'staff.read', module: 'Administration', description: 'View employees' },
  { key: 'staff.manage', module: 'Administration', description: 'Create and edit employees' },
  { key: 'staff.salary', module: 'Administration', description: 'View salaries and record salary payouts' },
  { key: 'branches.manage', module: 'Administration', description: 'Create and edit branches' },
  { key: 'roles.manage', module: 'Administration', description: 'Edit roles and permissions' },
  { key: 'settings.manage', module: 'Administration', description: 'Edit organization settings' },
  { key: 'automations.manage', module: 'Administration', description: 'Edit automation rules and messaging integrations' },
  { key: 'audit.read', module: 'Administration', description: 'View audit logs' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

const all = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLES: {
  key: string;
  name: string;
  description: string;
  allBranches: boolean;
  permissions: Permission[];
}[] = [
  { key: 'super_admin', name: 'Super Admin', description: 'Full access to every branch and setting', allBranches: true, permissions: all },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    description: 'Runs an assigned branch',
    allBranches: false,
    permissions: all.filter((p) => !['branches.manage', 'roles.manage', 'settings.manage', 'automations.manage'].includes(p)),
  },
  {
    key: 'front_desk',
    name: 'Front Desk',
    description: 'Registrations, renewals and collections',
    allBranches: false,
    permissions: ['dashboard.view', 'members.read', 'members.write', 'members.credentials', 'plans.read', 'memberships.manage', 'payments.read', 'payments.create', 'invoices.read',
      'leads.read', 'leads.write', 'followups.manage', 'communications.log',
      'attendance.read', 'attendance.checkin', 'staff.attendance', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage', 'pt.sell',
      'workouts.read', 'assessments.read', 'pos.sell', 'inventory.read', 'referrals.manage', 'events.read', 'events.manage'],
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Membership sales and renewals',
    allBranches: false,
    permissions: ['dashboard.view', 'members.read', 'members.write', 'plans.read', 'memberships.manage', 'payments.read', 'invoices.read',
      'leads.read', 'leads.write', 'followups.manage', 'communications.log', 'segments.manage',
      'attendance.read', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage', 'pt.sell', 'assessments.read', 'pos.sell', 'referrals.manage', 'events.read', 'marketing.read', 'marketing.manage'],
  },
  { key: 'trainer', name: 'Trainer', description: 'Assigned members and training', allBranches: false, permissions: ['members.read', 'plans.read', 'followups.manage', 'communications.log', 'attendance.read', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage',
    'workouts.read', 'workouts.manage', 'nutrition.read', 'assessments.read', 'assessments.manage', 'events.read', 'events.manage'] },
  { key: 'nutritionist', name: 'Nutritionist', description: 'Assigned members and nutrition', allBranches: false, permissions: ['members.read', 'followups.manage', 'communications.log', 'appointments.read', 'appointments.manage',
    'nutrition.read', 'nutrition.manage', 'workouts.read', 'assessments.read', 'assessments.manage', 'events.read'] },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Payments, invoices and financial reports',
    allBranches: true,
    permissions: ['dashboard.view', 'members.read', 'plans.read', 'payments.read', 'payments.create', 'payments.void', 'invoices.read', 'reports.read', 'audit.read', 'communications.log', 'attendance.read',
      'pos.refund', 'inventory.read', 'expenses.read', 'expenses.manage', 'staff.salary', 'events.read', 'marketing.read'],
  },
];
