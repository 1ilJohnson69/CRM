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
  { key: 'plans.read', module: 'Memberships', description: 'View membership plans' },
  { key: 'plans.manage', module: 'Memberships', description: 'Create and edit membership plans' },
  { key: 'memberships.manage', module: 'Memberships', description: 'Sell, renew, freeze and cancel memberships' },
  { key: 'payments.read', module: 'Finance', description: 'View payments' },
  { key: 'payments.create', module: 'Finance', description: 'Record payments' },
  { key: 'payments.void', module: 'Finance', description: 'Void recorded payments' },
  { key: 'invoices.read', module: 'Finance', description: 'View and print invoices' },
  { key: 'reports.read', module: 'Analytics', description: 'View revenue and membership analytics' },
  { key: 'staff.read', module: 'Administration', description: 'View employees' },
  { key: 'staff.manage', module: 'Administration', description: 'Create and edit employees' },
  { key: 'branches.manage', module: 'Administration', description: 'Create and edit branches' },
  { key: 'roles.manage', module: 'Administration', description: 'Edit roles and permissions' },
  { key: 'settings.manage', module: 'Administration', description: 'Edit organization settings' },
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
    permissions: all.filter((p) => !['branches.manage', 'roles.manage', 'settings.manage'].includes(p)),
  },
  {
    key: 'front_desk',
    name: 'Front Desk',
    description: 'Registrations, renewals and collections',
    allBranches: false,
    permissions: ['dashboard.view', 'members.read', 'members.write', 'members.credentials', 'plans.read', 'memberships.manage', 'payments.read', 'payments.create', 'invoices.read',
      'leads.read', 'leads.write', 'followups.manage', 'communications.log',
      'attendance.read', 'attendance.checkin', 'staff.attendance', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage', 'pt.sell'],
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Membership sales and renewals',
    allBranches: false,
    permissions: ['dashboard.view', 'members.read', 'members.write', 'plans.read', 'memberships.manage', 'payments.read', 'invoices.read',
      'leads.read', 'leads.write', 'followups.manage', 'communications.log', 'segments.manage',
      'attendance.read', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage', 'pt.sell'],
  },
  { key: 'trainer', name: 'Trainer', description: 'Assigned members and training', allBranches: false, permissions: ['members.read', 'plans.read', 'followups.manage', 'communications.log', 'attendance.read', 'classes.read', 'classes.book', 'appointments.read', 'appointments.manage'] },
  { key: 'nutritionist', name: 'Nutritionist', description: 'Assigned members and nutrition', allBranches: false, permissions: ['members.read', 'followups.manage', 'communications.log', 'appointments.read', 'appointments.manage'] },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Payments, invoices and financial reports',
    allBranches: true,
    permissions: ['dashboard.view', 'members.read', 'plans.read', 'payments.read', 'payments.create', 'payments.void', 'invoices.read', 'reports.read', 'audit.read', 'communications.log', 'attendance.read'],
  },
];
