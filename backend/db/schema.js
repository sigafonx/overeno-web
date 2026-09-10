/**
 * Adds a column to an existing table if it's missing. Used to migrate
 * databases created before a column existed — CREATE TABLE below already
 * includes these columns for brand-new databases, this just catches
 * databases from an earlier version of schema.js. Safe to call every
 * startup: it only ALTERs when the column is genuinely absent.
 */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Creates every table and index used by the backend, if they don't already
 * exist. Safe to call on every startup (and from the migration script) —
 * `CREATE TABLE/INDEX IF NOT EXISTS` never throws on a database that's
 * already set up.
 */
export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      language TEXT,
      source TEXT,
      pageUrl TEXT,
      companyName TEXT,
      contactName TEXT,
      email TEXT,
      phone TEXT,
      city TEXT,
      vehiclesCount TEXT,
      qualification TEXT,
      availability TEXT,
      message TEXT,
      internalNote TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_type ON leads(type);
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
    CREATE INDEX IF NOT EXISTS idx_leads_city ON leads(city);
    CREATE INDEX IF NOT EXISTS idx_leads_createdAt ON leads(createdAt);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      vin TEXT,
      listingUrl TEXT,
      city TEXT NOT NULL,
      preferredSlot TEXT NOT NULL,
      contactName TEXT,
      email TEXT,
      phone TEXT,
      language TEXT,
      source TEXT,
      pageUrl TEXT,
      message TEXT,
      internalNote TEXT,
      paidAt TEXT,
      paymentId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_city ON bookings(city);
    CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);
    CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
    CREATE INDEX IF NOT EXISTS idx_bookings_vin ON bookings(vin);
    CREATE INDEX IF NOT EXISTS idx_bookings_createdAt ON bookings(createdAt);

    CREATE TABLE IF NOT EXISTS vin_checks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      vin TEXT NOT NULL,
      language TEXT,
      source TEXT,
      pageUrl TEXT,
      score INTEGER,
      riskLevel TEXT,
      year INTEGER,
      estimatedMileage INTEGER,
      advertisedMileage INTEGER,
      accidents INTEGER,
      owners INTEGER,
      odometerRisk TEXT,
      verdictKey TEXT,
      isDemoResult INTEGER,
      disclaimer TEXT,
      internalNote TEXT,
      paymentStatus TEXT,
      paidAt TEXT,
      paymentId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vinchecks_vin ON vin_checks(vin);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_riskLevel ON vin_checks(riskLevel);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_source ON vin_checks(source);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_language ON vin_checks(language);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_createdAt ON vin_checks(createdAt);

    CREATE TABLE IF NOT EXISTS email_logs (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      recipientType TEXT NOT NULL,
      recipientEmail TEXT,
      subject TEXT,
      status TEXT NOT NULL,
      errorMessage TEXT,
      createdAt TEXT NOT NULL,
      reviewedAt TEXT,
      resolvedAt TEXT,
      internalNote TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emaillogs_entityType ON email_logs(entityType);
    CREATE INDEX IF NOT EXISTS idx_emaillogs_entityId ON email_logs(entityId);
    CREATE INDEX IF NOT EXISTS idx_emaillogs_status ON email_logs(status);
    CREATE INDEX IF NOT EXISTS idx_emaillogs_createdAt ON email_logs(createdAt);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT,
      productCode TEXT NOT NULL,
      status TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      providerSessionId TEXT,
      providerPaymentId TEXT,
      checkoutUrl TEXT,
      customerEmail TEXT,
      customerName TEXT,
      metadataJson TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      paidAt TEXT,
      cancelledAt TEXT,
      failedAt TEXT,
      errorMessage TEXT,
      internalNote TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_entityType ON payments(entityType);
    CREATE INDEX IF NOT EXISTS idx_payments_entityId ON payments(entityId);
    CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider);
    CREATE INDEX IF NOT EXISTS idx_payments_providerSessionId ON payments(providerSessionId);
    CREATE INDEX IF NOT EXISTS idx_payments_customerEmail ON payments(customerEmail);
    CREATE INDEX IF NOT EXISTS idx_payments_createdAt ON payments(createdAt);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT,
      active INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
    CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      status TEXT NOT NULL,
      reportType TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      verdict TEXT,
      riskLevel TEXT,
      score INTEGER,
      language TEXT,
      customerEmail TEXT,
      internalNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      draftReadyAt TEXT,
      reportReadyAt TEXT,
      sentAt TEXT,
      completedAt TEXT,
      cancelledAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_entityType ON reports(entityType);
    CREATE INDEX IF NOT EXISTS idx_reports_entityId ON reports(entityId);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_reportType ON reports(reportType);
    CREATE INDEX IF NOT EXISTS idx_reports_customerEmail ON reports(customerEmail);
    CREATE INDEX IF NOT EXISTS idx_reports_createdAt ON reports(createdAt);

    CREATE TABLE IF NOT EXISTS report_status_history (
      id TEXT PRIMARY KEY,
      reportId TEXT NOT NULL,
      oldStatus TEXT,
      newStatus TEXT NOT NULL,
      reason TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reportstatushistory_reportId ON report_status_history(reportId);

    CREATE TABLE IF NOT EXISTS report_sections (
      id TEXT PRIMARY KEY,
      reportId TEXT NOT NULL,
      sectionKey TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      sortOrder INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reportsections_reportId ON report_sections(reportId);
    CREATE INDEX IF NOT EXISTS idx_reportsections_sectionKey ON report_sections(sectionKey);
    CREATE INDEX IF NOT EXISTS idx_reportsections_sortOrder ON report_sections(sortOrder);

    CREATE TABLE IF NOT EXISTS ai_agent_runs (
      id TEXT PRIMARY KEY,
      agentName TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      status TEXT NOT NULL,
      inputJson TEXT,
      outputJson TEXT,
      errorMessage TEXT,
      model TEXT,
      provider TEXT,
      estimatedCost TEXT,
      requiresHumanReview INTEGER,
      reviewedAt TEXT,
      approvedAt TEXT,
      rejectedAt TEXT,
      reviewNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_airuns_agentName ON ai_agent_runs(agentName);
    CREATE INDEX IF NOT EXISTS idx_airuns_entityType ON ai_agent_runs(entityType);
    CREATE INDEX IF NOT EXISTS idx_airuns_entityId ON ai_agent_runs(entityId);
    CREATE INDEX IF NOT EXISTS idx_airuns_status ON ai_agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_airuns_createdAt ON ai_agent_runs(createdAt);

    CREATE TABLE IF NOT EXISTS ai_prompts (
      id TEXT PRIMARY KEY,
      agentName TEXT NOT NULL,
      promptVersion TEXT NOT NULL,
      promptText TEXT NOT NULL,
      active INTEGER,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aiprompts_agentName ON ai_prompts(agentName);

    CREATE TABLE IF NOT EXISTS vin_provider_runs (
      id TEXT PRIMARY KEY,
      vinCheckId TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      requestJson TEXT,
      responseJson TEXT,
      normalizedJson TEXT,
      costEstimate TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vinproviderruns_vinCheckId ON vin_provider_runs(vinCheckId);
    CREATE INDEX IF NOT EXISTS idx_vinproviderruns_provider ON vin_provider_runs(provider);
    CREATE INDEX IF NOT EXISTS idx_vinproviderruns_status ON vin_provider_runs(status);
    CREATE INDEX IF NOT EXISTS idx_vinproviderruns_createdAt ON vin_provider_runs(createdAt);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      agentName TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      taskType TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      suggestedAction TEXT,
      suggestedMessage TEXT,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      reviewedAt TEXT,
      completedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agenttasks_agentName ON agent_tasks(agentName);
    CREATE INDEX IF NOT EXISTS idx_agenttasks_entityType ON agent_tasks(entityType);
    CREATE INDEX IF NOT EXISTS idx_agenttasks_entityId ON agent_tasks(entityId);
    CREATE INDEX IF NOT EXISTS idx_agenttasks_taskType ON agent_tasks(taskType);
    CREATE INDEX IF NOT EXISTS idx_agenttasks_status ON agent_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agenttasks_createdAt ON agent_tasks(createdAt);

    CREATE TABLE IF NOT EXISTS inspectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      qualification TEXT,
      active INTEGER NOT NULL,
      internalNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspectors_city ON inspectors(city);
    CREATE INDEX IF NOT EXISTS idx_inspectors_active ON inspectors(active);

    CREATE TABLE IF NOT EXISTS inspection_jobs (
      id TEXT PRIMARY KEY,
      bookingId TEXT NOT NULL,
      inspectorId TEXT,
      status TEXT NOT NULL,
      scheduledAt TEXT,
      location TEXT,
      customerContact TEXT,
      internalNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inspectionjobs_bookingId ON inspection_jobs(bookingId);
    CREATE INDEX IF NOT EXISTS idx_inspectionjobs_inspectorId ON inspection_jobs(inspectorId);
    CREATE INDEX IF NOT EXISTS idx_inspectionjobs_status ON inspection_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_inspectionjobs_createdAt ON inspection_jobs(createdAt);

    CREATE TABLE IF NOT EXISTS inspection_checklist_items (
      id TEXT PRIMARY KEY,
      jobId TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT,
      comment TEXT,
      sortOrder INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspectionchecklist_jobId ON inspection_checklist_items(jobId);
    CREATE INDEX IF NOT EXISTS idx_inspectionchecklist_sortOrder ON inspection_checklist_items(sortOrder);

    CREATE TABLE IF NOT EXISTS dealers (
      id TEXT PRIMARY KEY,
      companyName TEXT NOT NULL,
      contactName TEXT,
      email TEXT,
      phone TEXT,
      city TEXT,
      website TEXT,
      status TEXT NOT NULL,
      internalNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dealers_status ON dealers(status);
    CREATE INDEX IF NOT EXISTS idx_dealers_email ON dealers(email);
    CREATE INDEX IF NOT EXISTS idx_dealers_city ON dealers(city);

    CREATE TABLE IF NOT EXISTS dealer_vehicles (
      id TEXT PRIMARY KEY,
      dealerId TEXT NOT NULL,
      vin TEXT,
      make TEXT,
      model TEXT,
      year INTEGER,
      listingUrl TEXT,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dealervehicles_dealerId ON dealer_vehicles(dealerId);
    CREATE INDEX IF NOT EXISTS idx_dealervehicles_status ON dealer_vehicles(status);
    CREATE INDEX IF NOT EXISTS idx_dealervehicles_vin ON dealer_vehicles(vin);

    CREATE TABLE IF NOT EXISTS verified_badges (
      id TEXT PRIMARY KEY,
      dealerId TEXT NOT NULL,
      vehicleId TEXT NOT NULL,
      status TEXT NOT NULL,
      badgeCode TEXT NOT NULL UNIQUE,
      issuedAt TEXT,
      expiresAt TEXT,
      revokedAt TEXT,
      internalNote TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verifiedbadges_dealerId ON verified_badges(dealerId);
    CREATE INDEX IF NOT EXISTS idx_verifiedbadges_vehicleId ON verified_badges(vehicleId);
    CREATE INDEX IF NOT EXISTS idx_verifiedbadges_status ON verified_badges(status);
    CREATE INDEX IF NOT EXISTS idx_verifiedbadges_badgeCode ON verified_badges(badgeCode);

    -- Transparent revenue-share bookkeeping — see backend/README.md's
    -- "Revenue-share 20%" section. Calculation and ledger only in this
    -- step; no automatic money movement anywhere in this schema or the
    -- code that reads/writes it.
    CREATE TABLE IF NOT EXISTS revenue_share_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      sharePercent INTEGER NOT NULL DEFAULT 20,
      timezone TEXT NOT NULL DEFAULT 'Europe/Prague',
      payoutDay INTEGER NOT NULL DEFAULT 1,
      payoutTime TEXT NOT NULL DEFAULT '10:00',
      payoutMethod TEXT,
      payoutRecipientLabel TEXT,
      payoutRecipientMasked TEXT,
      notes TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revenue_share_ledger (
      id TEXT PRIMARY KEY,
      paymentId TEXT NOT NULL,
      paymentAmount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      sharePercent INTEGER NOT NULL,
      shareAmount INTEGER NOT NULL,
      paymentPaidAt TEXT NOT NULL,
      monthKey TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revenueshareledger_paymentId ON revenue_share_ledger(paymentId);
    CREATE INDEX IF NOT EXISTS idx_revenueshareledger_monthKey ON revenue_share_ledger(monthKey);
    CREATE INDEX IF NOT EXISTS idx_revenueshareledger_status ON revenue_share_ledger(status);
    CREATE INDEX IF NOT EXISTS idx_revenueshareledger_createdAt ON revenue_share_ledger(createdAt);

    CREATE TABLE IF NOT EXISTS monthly_payouts (
      id TEXT PRIMARY KEY,
      monthKey TEXT NOT NULL,
      currency TEXT NOT NULL,
      grossRevenue INTEGER NOT NULL,
      sharePercent INTEGER NOT NULL,
      shareAmount INTEGER NOT NULL,
      status TEXT NOT NULL,
      payoutDueAt TEXT NOT NULL,
      payoutMethod TEXT,
      payoutRecipientMasked TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      markedPaidAt TEXT,
      internalNote TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monthlypayouts_monthKey ON monthly_payouts(monthKey);
    CREATE INDEX IF NOT EXISTS idx_monthlypayouts_status ON monthly_payouts(status);
    CREATE INDEX IF NOT EXISTS idx_monthlypayouts_payoutDueAt ON monthly_payouts(payoutDueAt);
  `);

  // Migrate any database created before this step existed (fresh databases
  // already have these columns from the CREATE TABLE statements above —
  // ensureColumn() is then just a fast no-op for them).
  ensureColumn(db, 'bookings', 'paidAt', 'TEXT');
  ensureColumn(db, 'bookings', 'paymentId', 'TEXT');
  ensureColumn(db, 'vin_checks', 'paymentStatus', 'TEXT');
  ensureColumn(db, 'vin_checks', 'paidAt', 'TEXT');
  ensureColumn(db, 'vin_checks', 'paymentId', 'TEXT');
  // internalNote has been in the vin_checks CREATE TABLE statement above
  // since this table was first created (it started life as an empty
  // string on every JSON-era record) — this call is a no-op in practice,
  // kept only as the same safety net every other column gets.
  ensureColumn(db, 'vin_checks', 'internalNote', 'TEXT');

  // Manual admin review state for email_logs — genuinely new columns this
  // time (unlike vin_checks.internalNote, which already existed), so this
  // migration path is real for any database created before this step.
  ensureColumn(db, 'email_logs', 'reviewedAt', 'TEXT');
  ensureColumn(db, 'email_logs', 'resolvedAt', 'TEXT');
  ensureColumn(db, 'email_logs', 'internalNote', 'TEXT');

  // Admin-only free-text note for payments — genuinely new column for any
  // database created before this step (like email_logs' three fields
  // above, unlike vin_checks.internalNote which already existed).
  ensureColumn(db, 'payments', 'internalNote', 'TEXT');

  // Agent assignment — one nullable column per assignable entity, rather
  // than a separate assignments join table. Simpler to query (no joins in
  // the existing list/detail routes), simpler to test, and consistent
  // with how every other per-entity admin field (internalNote, paidAt,
  // etc.) has been added so far. NULL/unset = unassigned; existing rows
  // are unaffected (they just read as unassigned, nothing breaks).
  ensureColumn(db, 'leads', 'assignedAgentId', 'TEXT');
  ensureColumn(db, 'bookings', 'assignedAgentId', 'TEXT');
  ensureColumn(db, 'vin_checks', 'assignedAgentId', 'TEXT');
  ensureColumn(db, 'payments', 'assignedAgentId', 'TEXT');

  // Distinct from cancelledAt: Stripe's checkout.session.expired means the
  // customer let the session time out (never opened/finished checkout),
  // which is a meaningfully different signal from an explicit cancel —
  // genuinely new column for any database created before this step.
  ensureColumn(db, 'payments', 'expiredAt', 'TEXT');

  // Secure public report delivery — a nullable token per report, set only
  // when an admin explicitly generates one (never automatically). NULL
  // publicToken = no public link exists yet for this report.
  ensureColumn(db, 'reports', 'publicToken', 'TEXT');
  ensureColumn(db, 'reports', 'publicTokenCreatedAt', 'TEXT');
  ensureColumn(db, 'reports', 'publicTokenRevokedAt', 'TEXT');
  ensureColumn(db, 'reports', 'deliveredAt', 'TEXT');

  // Tracks whether an approved AI run's output has been applied to its
  // report (see backend/ai/applyToReport.js) — never set automatically,
  // only when POST /admin/ai/runs/:id/apply succeeds.
  ensureColumn(db, 'ai_agent_runs', 'appliedAt', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookings_paymentId ON bookings(paymentId);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_paymentId ON vin_checks(paymentId);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_paymentStatus ON vin_checks(paymentStatus);
    CREATE INDEX IF NOT EXISTS idx_leads_assignedAgentId ON leads(assignedAgentId);
    CREATE INDEX IF NOT EXISTS idx_bookings_assignedAgentId ON bookings(assignedAgentId);
    CREATE INDEX IF NOT EXISTS idx_vinchecks_assignedAgentId ON vin_checks(assignedAgentId);
    CREATE INDEX IF NOT EXISTS idx_payments_assignedAgentId ON payments(assignedAgentId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_publicToken ON reports(publicToken);
    CREATE INDEX IF NOT EXISTS idx_reports_deliveredAt ON reports(deliveredAt);
  `);
}
