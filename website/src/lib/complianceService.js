import { supabase } from './supabase';
import { getISOWeekString, getPreviousISOWeekString, isWeekCompleted } from './weekUtils';

/**
 * Calculates compliance metrics for a single worker for a given week.
 * Target: $40.00 in valid (approved or pending, not rejected) claims.
 */
export function calculateWorkerCompliance(worker, workerWeekClaims = []) {
  const validClaims = workerWeekClaims.filter(c => c.status !== 'rejected');
  const rejectedClaims = workerWeekClaims.filter(c => c.status === 'rejected');
  
  const totalValidAmount = validClaims.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  const approvedAmount = validClaims
    .filter(c => c.status === 'approved')
    .reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  const pendingAmount = validClaims
    .filter(c => c.status === 'pending')
    .reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

  const targetAmount = 40.00;
  const isCompliant = totalValidAmount >= targetAmount;
  const remainingAmount = Math.max(0, targetAmount - totalValidAmount);

  return {
    isCompliant,
    totalValidAmount,
    approvedAmount,
    pendingAmount,
    targetAmount,
    remainingAmount,
    validClaimsCount: validClaims.length,
    rejectedClaimsCount: rejectedClaims.length,
    validClaims,
    rejectedClaims
  };
}

/**
 * Checks if a worker is considered a new user / new worker.
 * Rules:
 * 1. An account created less than 7 days ago.
 * 2. An account created in the current ISO week cycle.
 * 3. An account created on or after the start date of the audited week (or during/after auditWeek).
 * 4. Missing created_at timestamp defaults to safe (treated as exempt/new to prevent accidental auto-suspension).
 */
export function isNewWorker(worker, auditWeek = null) {
  if (!worker) return false;
  if (!worker.created_at) return true; // Safety default: missing creation date should never be falsely auto-suspended

  const createdAt = new Date(worker.created_at).getTime();
  if (isNaN(createdAt)) return true;

  const now = Date.now();
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000; // 14-day grace period for new registrations

  // Rule 1: Account created within the last 14 days
  if (now - createdAt < FOURTEEN_DAYS_MS) {
    return true;
  }

  // Rule 2: Account created during the current active ISO week
  const currentWeek = getISOWeekString(new Date(now));
  const createdWeek = getISOWeekString(new Date(createdAt));
  if (createdWeek === currentWeek) {
    return true;
  }

  // Rule 3: If an audit week is being evaluated, accounts created during or after that audit week are new to that cycle
  if (auditWeek && createdWeek >= auditWeek) {
    return true;
  }

  return false;
}

/**
 * Checks if current time is the Sunday weekly cutoff window (23:59 / 00:59).
 * Rule: Auto-suspensions may ONLY occur at 23:59 of Sunday / 00:59 Monday cutoff, never on any other day of the week.
 */
export function isSundayCutoffTime(d = new Date()) {
  const day = d.getDay(); // 0 is Sunday, 1 is Monday
  const hours = d.getHours();
  const minutes = d.getMinutes();

  // Sunday night cutoff: Sunday 23:50 - 23:59 OR Monday 00:00 - 00:59 (the weekly cutoff window)
  if (day === 0 && hours === 23 && minutes >= 50) return true;
  if (day === 1 && hours === 0 && minutes <= 59) return true;
  return false;
}

/**
 * Checks if a worker is exempt from suspensions (e.g. Admins, Seed Admins, New Workers)
 */
export function isExemptFromSuspension(worker, auditWeek = null) {
  if (!worker) return true;
  if (['admin', 'super_admin', 'seed_admin'].includes(worker.role)) return true;
  if (import.meta.env.VITE_SEED_ADMIN_EMAIL && (worker.email || '').toLowerCase() === import.meta.env.VITE_SEED_ADMIN_EMAIL.toLowerCase()) return true;
  if (isNewWorker(worker, auditWeek)) return true;
  return false;
}

/**
 * Executes a full compliance audit for a given week identifier.
 * Evaluates ALL eligible non-exempt workers (new workers are strictly protected).
 * A worker is compliant if their valid claims total >= $40.00.
 */
export async function executeWeeklyComplianceAudit(auditWeek, { enforce = true, supabaseClient = supabase } = {}) {
  if (!auditWeek) throw new Error('auditWeek is required');

  // 1. Fetch all worker profiles
  const { data: profiles, error: pErr } = await supabaseClient
    .from('profiles')
    .select('*')
    .order('email', { ascending: true });

  if (pErr) throw pErr;

  // 2. Fetch all claims for this week
  const { data: claims, error: cErr } = await supabaseClient
    .from('worker_claims')
    .select('*')
    .eq('week_identifier', auditWeek);

  if (cErr) throw cErr;

  const rawWorkers = (profiles || []).filter(p => p.role === 'worker');
  const allWorkers = rawWorkers.filter(p => !isExemptFromSuspension(p, auditWeek));
  const newWorkersSkipped = rawWorkers.filter(p => isNewWorker(p, auditWeek));
  const weekClaims = claims || [];

  const defaultingWorkers = [];
  const compliantWorkers = [];
  const alreadyBlockedOrSuspended = [];

  for (const worker of allWorkers) {
    const isAlreadySuspended = worker.is_auto_suspended === true;
    const isAlreadyBlocked = worker.is_blocked === true;

    if (isAlreadySuspended || isAlreadyBlocked) {
      alreadyBlockedOrSuspended.push({
        worker,
        reason: worker.blocked_reason || (isAlreadySuspended ? 'Auto-Suspended' : 'Blocked')
      });
      continue;
    }

    const workerClaims = weekClaims.filter(c => c.worker_id === worker.id);
    const metrics = calculateWorkerCompliance(worker, workerClaims);

    if (metrics.isCompliant) {
      compliantWorkers.push({ worker, metrics });
    } else {
      defaultingWorkers.push({ worker, metrics });
    }
  }

  // 3. Enforce suspensions if requested
  const suspendedWorkers = [];
  if (enforce && defaultingWorkers.length > 0) {
    for (const item of defaultingWorkers) {
      const { worker, metrics } = item;
      const blockedReason = `Due to failing to achieve weekly target rule as per your subscribed plan (Submitted $${metrics.totalValidAmount.toFixed(2)} of $40.00 required for week ${auditWeek}), the system has auto-suspended you and you are required to leave the station before tomorrow at 8 AM, as your services are no longer needed.`;

      const { error: updErr } = await supabaseClient
        .from('profiles')
        .update({
          is_auto_suspended: true,
          is_blocked: true,
          auto_suspended_week: auditWeek,
          blocked_reason: blockedReason
        })
        .eq('id', worker.id);

      if (!updErr) {
        suspendedWorkers.push(worker);

        // Send in-app notification
        try {
          await supabaseClient.from('user_notifications').insert([{
            user_id: worker.id,
            user_email: worker.email,
            title: `SYSTEM AUDIT: Account Auto-Suspended (Target Default — Week ${auditWeek})`,
            message: `You have been automatically suspended for failing to achieve the weekly $40.00 requirement during week cycle ${auditWeek}. You submitted $${metrics.totalValidAmount.toFixed(2)} of $40.00 required. As per platform policy, you are required to leave the station before tomorrow at 8:00 AM.`,
            type: 'target_warning',
            metadata: {
              weekIdentifier: auditWeek,
              totalSubmitted: metrics.totalValidAmount,
              targetRequired: 40.00
            }
          }]);
        } catch (_) {}
      }
    }
  }

  return {
    auditWeek,
    totalEvaluated: allWorkers.length,
    newWorkersProtectedCount: newWorkersSkipped.length,
    defaultingCount: defaultingWorkers.length,
    compliantCount: compliantWorkers.length,
    suspendedCount: suspendedWorkers.length,
    defaultingWorkers,
    compliantWorkers,
    alreadyBlockedOrSuspended,
    newWorkersSkipped
  };
}

/**
 * Automated runtime check:
 * STRICT PLATFORM RULE: Auto-suspensions may ONLY occur at 23:59 of Sunday, never on any other day of the week.
 * Furthermore, NEW WORKERS are strictly protected and NEVER auto-suspended.
 */
export async function autoCheckAndEnforcePastWeekAudit(currentProfile) {
  if (!currentProfile) return null;

  // Worker logins NEVER evaluate or enforce auto-suspension on themselves!
  // Compliance audit is strictly executed during Sunday 23:59 / Monday 00:59 cutoff window by the background engine or admin.
  if (currentProfile.role === 'worker') {
    return null;
  }

  // STRICT TIMING GUARD: Auto-suspension can ONLY execute during Sunday 23:59 / 00:59 weekly cutoff!
  if (!isSundayCutoffTime()) {
    return null;
  }

  const previousWeek = getPreviousISOWeekString();
  const currentWeek = getISOWeekString();

  // If previousWeek is the same as currentWeek, no past week to audit yet
  if (previousWeek === currentWeek) return null;

  // Admin / Seed Admin login enforcement on Sunday 23:59 / 00:59 cutoff
  const isAdmin = ['admin', 'super_admin', 'seed_admin'].includes(currentProfile.role) ||
                  (import.meta.env.VITE_SEED_ADMIN_EMAIL && currentProfile.email?.toLowerCase() === import.meta.env.VITE_SEED_ADMIN_EMAIL.toLowerCase());

  if (isAdmin) {
    const lockKey = `diamt_audit_last_enforced_${previousWeek}`;
    const lastRun = localStorage.getItem(lockKey);
    // Ensure audit runs only once during the Sunday 23:59 cutoff window
    if (lastRun && Date.now() - parseInt(lastRun, 10) < 30 * 60 * 1000) {
      return null;
    }

    try {
      const result = await executeWeeklyComplianceAudit(previousWeek, { enforce: true });
      localStorage.setItem(lockKey, String(Date.now()));
      return result;
    } catch (err) {
      console.error('[complianceService] Error in admin background audit enforcement:', err);
    }
  }

  return null;
}
