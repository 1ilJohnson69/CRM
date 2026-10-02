import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/app.css';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ToastProvider } from './lib/ui';
import { ApiError } from './lib/api';
import { Shell } from './components/layout/Shell';
import { NAV } from './components/layout/nav';
import { Dashboard } from './features/dashboard/Dashboard';
import { MembersList } from './features/members/MembersList';
import { MemberProfile } from './features/members/MemberProfile';
import { MembershipsPage } from './features/memberships/MembershipsPage';
import { InvoiceDetail, InvoicesPage, PaymentsPage } from './features/billing/BillingPages';
import { AuditPage, BranchesPage, EmployeesPage, RolesPage, SettingsPage } from './features/admin/AdminPages';
import { AccountPage, LoginPage, NotFoundPage, PlannedPage } from './features/auth/AuthPages';
import { Empty } from './components/ui';
import { LeadsPage } from './features/crm/LeadsPage';
import { FollowUpsPage } from './features/crm/FollowUpsPage';
import { SegmentDetail, SegmentsPage } from './features/crm/SegmentsPage';
import { CommunicationPage } from './features/crm/CommunicationPage';
import { FrontDeskPage } from './features/ops/FrontDeskPage';
import { AttendancePage } from './features/ops/AttendancePage';
import { ClassesPage } from './features/ops/ClassesPage';
import { AppointmentsPage } from './features/ops/AppointmentsPage';
import { PtPage } from './features/ops/PtPage';
import { AssessmentsPage, NutritionPage, WorkoutsPage } from './features/fitness/FitnessPages';
import { WorkoutEditor } from './features/fitness/WorkoutEditor';
import { NutritionEditor } from './features/fitness/NutritionEditor';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function Guard({ perm, children }: { perm?: string; children: ReactNode }) {
  const { can } = useAuth();
  if (perm && !can(perm)) return <div className="page"><Empty title="You don't have access to this page">Ask a Super Admin to update your role.</Empty></div>;
  return <>{children}</>;
}

function App() {
  const { me, loading, can } = useAuth();
  if (loading) return null;
  if (!me) return <LoginPage />;
  const planned = NAV.flatMap((g) => g.items).filter((i) => i.phase);
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={can('dashboard.view') ? <Dashboard /> : <Navigate to="/members" replace />} />
        <Route path="members" element={<Guard perm="members.read"><MembersList /></Guard>} />
        <Route path="members/:id" element={<Guard perm="members.read"><MemberProfile /></Guard>} />
        <Route path="leads" element={<Guard perm="leads.read"><LeadsPage /></Guard>} />
        <Route path="follow-ups" element={<Guard perm="followups.manage"><FollowUpsPage /></Guard>} />
        <Route path="segments" element={<Guard perm="members.read"><SegmentsPage /></Guard>} />
        <Route path="segments/:id" element={<Guard perm="members.read"><SegmentDetail /></Guard>} />
        <Route path="communication" element={<Guard perm="communications.log"><CommunicationPage /></Guard>} />
        <Route path="front-desk" element={<Guard perm="attendance.checkin"><FrontDeskPage /></Guard>} />
        <Route path="attendance" element={<Guard perm="attendance.read"><AttendancePage /></Guard>} />
        <Route path="classes" element={<Guard perm="classes.read"><ClassesPage /></Guard>} />
        <Route path="appointments" element={<Guard perm="appointments.read"><AppointmentsPage /></Guard>} />
        <Route path="pt" element={<Guard perm="appointments.read"><PtPage /></Guard>} />
        <Route path="workouts" element={<Guard perm="workouts.read"><WorkoutsPage /></Guard>} />
        <Route path="workouts/plans/:id" element={<Guard perm="workouts.read"><WorkoutEditor /></Guard>} />
        <Route path="nutrition" element={<Guard perm="nutrition.read"><NutritionPage /></Guard>} />
        <Route path="nutrition/plans/:id" element={<Guard perm="nutrition.read"><NutritionEditor /></Guard>} />
        <Route path="assessments" element={<Guard perm="assessments.read"><AssessmentsPage /></Guard>} />
        <Route path="memberships" element={<Guard perm="plans.read"><MembershipsPage /></Guard>} />
        <Route path="payments" element={<Guard perm="payments.read"><PaymentsPage /></Guard>} />
        <Route path="invoices" element={<Guard perm="invoices.read"><InvoicesPage /></Guard>} />
        <Route path="invoices/:id" element={<Guard perm="invoices.read"><InvoiceDetail /></Guard>} />
        <Route path="admin/employees" element={<Guard perm="staff.read"><EmployeesPage /></Guard>} />
        <Route path="admin/branches" element={<BranchesPage />} />
        <Route path="admin/roles" element={<Guard perm="roles.manage"><RolesPage /></Guard>} />
        <Route path="admin/settings" element={<Guard perm="settings.manage"><SettingsPage /></Guard>} />
        <Route path="admin/audit" element={<Guard perm="audit.read"><AuditPage /></Guard>} />
        <Route path="account" element={<AccountPage />} />
        {planned.map((p) => <Route key={p.to} path={p.to.slice(1)} element={<PlannedPage />} />)}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
