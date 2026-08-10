/**
 * src/db/seeds.ts
 * Seeds the lookup tables (squad_members, reason_codes) from the master file data.
 * Safe to re-run — uses INSERT OR REPLACE so corrections are applied on re-seed.
 *
 * REASON CODE SOURCE OF TRUTH:
 *   CMT Metrics 1Q 2026_MASTERFILE_Jan to June.xlsx → REASON CODES sheet
 *   The sheet has two effective-date blocks:
 *     Block 1 (Jan/Feb)  — A1–A24, R1–R12, M1–M20, T1, T3
 *     Block 2 (Mar+)     — A1–A28, R1–R12, M1–M23, T1, T3
 *   We seed BOTH blocks with their effective_date so the transform engine can
 *   use date-appropriate lookups.  For current data (2026 Q1–Q2) the Mar+ block
 *   is the relevant one.
 */

import { getDb } from './schema';

export function seedSquadMembers(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO squad_members (email_raw, email, name, sap_id)
    VALUES (@email_raw, @email, @name, @sap_id)
  `);

  const members = [
    { email_raw: 'Tanya Vanelli Rigor/Philippines/IBM',        email: '9rigort@ph.ibm.com',             name: 'Tanya Rigor',             sap_id: null },
    { email_raw: 'Enrique A Mangila/Philippines/IBM',          email: '9mangiea@ph.ibm.com',            name: 'Enrique Mangila',         sap_id: null },
    { email_raw: 'Dylana Bartolome/Philippines/IBM',           email: 'dylana.bartolome@ibm.com',       name: 'Diane Bartolome',         sap_id: null },
    { email_raw: 'Litton Ray O Balandra/Philippines/IBM',      email: '9balanlo@ph.ibm.com',            name: 'Litton Balandra',         sap_id: null },
    { email_raw: 'Michael Joseph Sermino/Philippines/IBM',     email: 'michael.j.sermino@ibm.com',      name: 'Michael Sermino',         sap_id: null },
    { email_raw: 'SAMANTHA LONTOC/Philippines/IBM',            email: 'samantha.lontoc@ibm.com',        name: 'SAMANTHA LONTOC',         sap_id: null },
    { email_raw: 'Ma. Milagros S Valenton/Philippines/IBM',    email: '9valenms@ph.ibm.com',            name: 'Ma Valenton',             sap_id: null },
    { email_raw: 'Elizabeth De Guzman/Philippines/IBM',        email: 'elizabeth.deguzman@ibm.com',     name: 'Elizabeth Guzman',        sap_id: null },
    { email_raw: 'Rey Angelo Angeles/Philippines/IBM',         email: 'reyangeloangeles@ibm.com',       name: 'Rey Angeles',             sap_id: null },
    { email_raw: 'William Paulo Esplana/Philippines/IBM',      email: '9esplaww@ph.ibm.com',            name: 'William Paulo Esplana',   sap_id: null },
    { email_raw: 'KARINA VICTORIA CHUA1/Philippines/IBM',      email: 'karvi.chua@ibm.com',             name: 'KARINA VICTORIA CHUA',    sap_id: null },
    { email_raw: 'Alexander Gabon/Philippines/IBM',            email: 'alexander.gabon@ibm.com',        name: 'Alexander Gabon',         sap_id: null },
    { email_raw: 'Alexandre Ronqui/Philippines/IBM',           email: 'alexandre.ronqui@ibm.com',       name: 'Alexandre Ronqui',        sap_id: null },
  ];

  const seedAll = db.transaction(() => {
    for (const m of members) insert.run(m);
  });
  seedAll();
}

export function seedReasonCodes(): void {
  const db = getDb();

  // Use INSERT OR REPLACE so re-seeding always applies the latest correct data
  const insert = db.prepare(`
    INSERT OR REPLACE INTO reason_codes
      (sub_process, code_num, reason_code, complexity, weight, process, effective_date, active)
    VALUES
      (@sub_process, @code_num, @reason_code, @complexity, @weight, @process, @effective_date, 1)
  `);

  // ───────────────────────────────────────────────────────────────────────────
  // Format: [sub_process, code_num, reason_code, complexity, weight, process]
  // ───────────────────────────────────────────────────────────────────────────

  // ── BLOCK 1: Jan / Feb effective date ─────────────────────────────────────
  const janFeb: [string, number, string, string, number, string][] = [
    // Accounts Management (A1–A24)
    ['Agreement Update',                    1,  'A1',  'Less Complex', 1,    'Accounts Management'],
    ['Anniv Date Change',                   2,  'A2',  'Simple',       0.5,  'Accounts Management'],
    ['Contact Creation',                    3,  'A3',  'Simple',       0.5,  'Accounts Management'],
    ['Contact Update',                      4,  'A4',  'Simple',       0.5,  'Accounts Management'],
    ['DPL',                                 5,  'A5',  'Simple',       0.5,  'Accounts Management'],
    ['ICN Creation',                        6,  'A6',  'Average',      1.5,  'Accounts Management'],
    ['ICN Link',                            7,  'A7',  'Simple',       0.5,  'Accounts Management'],
    ['ICN Update (Simple)',                 8,  'A8',  'Average',      1.5,  'Accounts Management'],
    ['LNC',                                 9,  'A9',  'Average',      1.5,  'Accounts Management'],
    ['PA Enrollment',                      10,  'A10', 'Average',      1.5,  'Accounts Management'],
    ['Site Creation',                      11,  'A11', 'Less Complex', 1,    'Accounts Management'],
    ['Site Update',                        12,  'A12', 'Less Complex', 1,    'Accounts Management'],
    ['SSA Credit (FD32)',                  13,  'A13', 'Average',      1.5,  'Accounts Management'],
    ['Tax Exempt',                         14,  'A14', 'Complex',      2.25, 'Accounts Management'],
    ['TCI',                                15,  'A15', 'Less Complex', 1,    'Accounts Management'],
    ['SSA Credit (F67)',                   16,  'A16', 'Simple',       0.5,  'Accounts Management'],
    ['ESA module site creation',           17,  'A17', 'Complex',      2.25, 'Accounts Management'],
    ['Bank Info',                          18,  'A18', 'Simple',       0.5,  'Accounts Management'],
    ['Contract Search/Archive (ECR)',      19,  'A19', 'Average',      1.5,  'Accounts Management'],
    ['Accounts Management Investigation', 20,  'A20', 'Complex',      2.25, 'Accounts Management'],
    ['GPO Profile Creation',              21,  'A21', 'Average',      1.5,  'Accounts Management'],
    ['Jira ICN Update',                   22,  'A22', 'Complex',      2.25, 'Accounts Management'],
    ['Credit Check',                      23,  'A23', 'Less Complex', 1,    'Accounts Management'],
    ['ICN Mapping',                       24,  'A24', 'Average',      1.5,  'Accounts Management'],
    // Renewals (R1–R12)
    ['Early Quote',                        1,  'R1',  'Less Complex', 1,    'Renewals'],
    ['Editor Addition',                    2,  'R2',  'Simple',       0.5,  'Renewals'],
    ['IDOC (Expected Price/Assortment Module)', 3, 'R3', 'Complex',   2.25, 'Renewals'],
    ['QRADAR Report',                      4,  'R4',  'Average',      1.5,  'Renewals'],
    ['Quote Creation (Standard)',          5,  'R5',  'Average',      1.5,  'Renewals'],
    ['Quote Update',                       6,  'R6',  'Complex',      2.25, 'Renewals'],
    ['Status Change',                      7,  'R7',  'Less Complex', 1,    'Renewals'],
    ['Compliance Quote Creation',          8,  'R8',  'Average',      1.5,  'Renewals'],
    ['IDOC (Others)',                      9,  'R9',  'Simple',       0.5,  'Renewals'],
    ['Renewals Investigation',            10,  'R10', 'Complex',      2.25, 'Renewals'],
    ['Quote Creation (Appliance)',        11,  'R11', 'Very Complex', 2.75, 'Renewals'],
    ['Quote PDF Request',                 12,  'R12', 'Simple',       0.5,  'Renewals'],
    // ME/Mi (M1–M20) — CORRECTED from master file
    ['Appliance ME',                       1,  'M1',  'Complex',      2.25, 'ME/Mi'],
    ['AVP ME',                             2,  'M2',  'Less Complex', 1,    'ME/Mi'],
    ['ELA ME (Less 500)',                  3,  'M3',  'Less Complex', 1,    'ME/Mi'],
    ['FCT ME',                             4,  'M4',  'Less Complex', 1,    'ME/Mi'],
    ['HP ME',                              5,  'M5',  'Less Complex', 1,    'ME/Mi'],
    ['ESA/OEM/OES ME',                     6,  'M6',  'Less Complex', 1,    'ME/Mi'],
    ['Sterling Connect Direct ME',         7,  'M7',  'Average',      1.5,  'ME/Mi'],
    ['General Adjustments ME',             8,  'M8',  'Average',      1.5,  'ME/Mi'],
    ['FCT to PA',                          9,  'M9',  'Complex',      2.25, 'ME/Mi'],
    ['ME/Mi Investigation',               10,  'M10', 'Complex',      2.25, 'ME/Mi'],
    ['License Exchange',                  11,  'M11', 'Complex',      2.25, 'ME/Mi'],
    ['ELA ME (More than 500)',            12,  'M12', 'Very Complex', 2.75, 'ME/Mi'],
    ['ME Reversal',                       13,  'M13', 'Less Complex', 1,    'ME/Mi'],
    ['Site Merge/Site Transfer',          14,  'M14', 'Less Complex', 1,    'ME/Mi'],
    ['License Transfer (Alloc/Dealloc)', 15,  'M15', 'Very Complex', 2.75, 'ME/Mi'],
    ['Cross Border Appliance Mi',         16,  'M16', 'Very Complex', 2.75, 'ME/Mi'],
    ['Support Extension',                 17,  'M17', 'Average',      1.5,  'ME/Mi'],
    ['Turbonomic Acquisition',            18,  'M18', 'Less Complex', 1,    'ME/Mi'],
    ['POE Request',                       19,  'M19', 'Simple',       0.5,  'ME/Mi'],
    ['Mi Reversal',                       20,  'M20', 'Very Complex', 2.75, 'ME/Mi'],
    // TReX — T1 (T2 not in master; T3 = HP O2O)
    ['TReX',                               1,  'T1',  'Less Complex', 1,    'TReX'],
    ['HP O2O',                             3,  'T3',  'Less Complex', 1,    'HP O2O'],
  ];

  // ── BLOCK 2: March onwards — superset with restructured A-codes and new M-codes
  const marOnwards: [string, number, string, string, number, string][] = [
    // Accounts Management (A1–A28, restructured)
    ['Agreement Update',                          1,  'A1',  'Less Complex', 1,    'Accounts Management'],
    ['Anniv Date Change',                         2,  'A2',  'Simple',       0.5,  'Accounts Management'],
    ['Contact Creation',                          3,  'A3',  'Simple',       0.5,  'Accounts Management'],
    ['Contact Update',                            4,  'A4',  'Simple',       0.5,  'Accounts Management'],
    ['DPL',                                       5,  'A5',  'Simple',       0.5,  'Accounts Management'],
    ['ICN Creation',                              6,  'A6',  'Average',      1.5,  'Accounts Management'],
    ['ICN Link',                                  7,  'A7',  'Simple',       0.5,  'Accounts Management'],
    ['ICN Update (Simple)',                       8,  'A8',  'Average',      1.5,  'Accounts Management'],
    ['LNC',                                       9,  'A9',  'Average',      1.5,  'Accounts Management'],
    ['PA enrollment = site, agreement and ICN creation', 10, 'A10', 'Average', 1.5, 'Accounts Management'],
    ['PA enrollment = site and agreement creation',      11, 'A11', 'Less Complex', 1, 'Accounts Management'],
    ['PA enrollment = additional site and ICN creation', 12, 'A12', 'Less Complex', 1, 'Accounts Management'],
    ['PA enrollment = additional site creation only',    13, 'A13', 'Simple', 0.5, 'Accounts Management'],
    ['PA enrollment = agreement creation only',          14, 'A14', 'Simple', 0.5, 'Accounts Management'],
    ['Site Creation',                            15,  'A15', 'Less Complex', 1,    'Accounts Management'],
    ['Site Update',                              16,  'A16', 'Less Complex', 1,    'Accounts Management'],
    ['SSA Credit (FD32)',                        17,  'A17', 'Average',      1.5,  'Accounts Management'],
    ['Tax Exempt',                               18,  'A18', 'Complex',      2.25, 'Accounts Management'],
    ['TCI',                                      19,  'A19', 'Less Complex', 1,    'Accounts Management'],
    ['SSA Credit (F67)',                         20,  'A20', 'Simple',       0.5,  'Accounts Management'],
    ['ESA module site creation',                 21,  'A21', 'Complex',      2.25, 'Accounts Management'],
    ['Bank Info',                                22,  'A22', 'Simple',       0.5,  'Accounts Management'],
    ['Contract Search/Archive (ECR)',            23,  'A23', 'Average',      1.5,  'Accounts Management'],
    ['Accounts Management Investigation',        24,  'A24', 'Complex',      2.25, 'Accounts Management'],
    ['GPO Profile Creation',                     25,  'A25', 'Average',      1.5,  'Accounts Management'],
    ['Jira ICN Update',                          26,  'A26', 'Complex',      2.25, 'Accounts Management'],
    ['Credit check',                             27,  'A27', 'Less Complex', 1,    'Accounts Management'],
    ['ICN mapping',                              28,  'A28', 'Average',      1.5,  'Accounts Management'],
    // Renewals (R1–R12) — same as Jan/Feb
    ['Early Quote',                               1,  'R1',  'Less Complex', 1,    'Renewals'],
    ['Editor Addition',                           2,  'R2',  'Simple',       0.5,  'Renewals'],
    ['IDOC (Expected Price/Assortment Module)',    3,  'R3',  'Complex',      2.25, 'Renewals'],
    ['QRADAR Report',                             4,  'R4',  'Average',      1.5,  'Renewals'],
    ['Quote Creation (Standard)',                 5,  'R5',  'Average',      1.5,  'Renewals'],
    ['Quote Update',                              6,  'R6',  'Complex',      2.25, 'Renewals'],
    ['Status Change',                             7,  'R7',  'Less Complex', 1,    'Renewals'],
    ['Compliance Quote Creation',                 8,  'R8',  'Average',      1.5,  'Renewals'],
    ['IDOC (Others)',                             9,  'R9',  'Simple',       0.5,  'Renewals'],
    ['Renewals Investigation',                   10,  'R10', 'Complex',      2.25, 'Renewals'],
    ['Quote Creation (Appliance)',               11,  'R11', 'Very Complex', 2.75, 'Renewals'],
    ['Quote PDF pull only',                      12,  'R12', 'Simple',       0.5,  'Renewals'],
    // ME/Mi (M1–M23) — CORRECTED + extended
    ['Appliance ME',                              1,  'M1',  'Complex',      2.25, 'ME/Mi'],
    ['AVP ME',                                    2,  'M2',  'Less Complex', 1,    'ME/Mi'],
    ['ELA ME (Less 500)',                         3,  'M3',  'Less Complex', 1,    'ME/Mi'],
    ['FCT ME',                                    4,  'M4',  'Less Complex', 1,    'ME/Mi'],
    ['HP ME',                                     5,  'M5',  'Less Complex', 1,    'ME/Mi'],
    ['ESA/OEM/OES ME',                            6,  'M6',  'Less Complex', 1,    'ME/Mi'],
    ['Sterling Connect Direct ME',                7,  'M7',  'Average',      1.5,  'ME/Mi'],
    ['General Adjustments ME',                    8,  'M8',  'Average',      1.5,  'ME/Mi'],
    ['FCT to PA',                                 9,  'M9',  'Complex',      2.25, 'ME/Mi'],
    ['ME/Mi Investigation',                      10,  'M10', 'Complex',      2.25, 'ME/Mi'],
    ['License Exchange',                         11,  'M11', 'Complex',      2.25, 'ME/Mi'],
    ['ELA ME (More than 500)',                   12,  'M12', 'Very Complex', 2.75, 'ME/Mi'],
    ['ME Reversal',                              13,  'M13', 'Less Complex', 1,    'ME/Mi'],
    ['Site transfer/site merge',                 14,  'M14', 'Less Complex', 1,    'ME/Mi'],
    ['License Transfer (Alloc/Dealloc)',         15,  'M15', 'Very Complex', 2.75, 'ME/Mi'],
    ['Cross Border Appliance Mi',                16,  'M16', 'Very Complex', 2.75, 'ME/Mi'],
    ['Support Extension',                        17,  'M17', 'Average',      1.5,  'ME/Mi'],
    ['Turbonomic Acquisition',                   18,  'M18', 'Less Complex', 1,    'ME/Mi'],
    ['POE Request',                              19,  'M19', 'Simple',       0.5,  'ME/Mi'],
    ['Mi Reversal',                              20,  'M20', 'Very Complex', 2.75, 'ME/Mi'],
    ['Allocation Entitlement',                   21,  'M21', 'Complex',      2.25, 'ME/Mi'],
    ['AAS to PA',                                22,  'M22', 'Complex',      2.25, 'ME/Mi'],
    ['SVP/SPP to PA/PAE',                        23,  'M23', 'Complex',      2.25, 'ME/Mi'],
    // TReX / HP O2O (unchanged)
    ['TReX',                                      1,  'T1',  'Less Complex', 1,    'TReX'],
    ['HP O2O',                                    3,  'T3',  'Less Complex', 1,    'HP O2O'],
  ];

  const seedAll = db.transaction(() => {
    for (const [sp, cn, rc, cx, w, p] of janFeb) {
      insert.run({ sub_process: sp, code_num: cn, reason_code: rc, complexity: cx, weight: w, process: p, effective_date: '2026-01-01' });
    }
    for (const [sp, cn, rc, cx, w, p] of marOnwards) {
      insert.run({ sub_process: sp, code_num: cn, reason_code: rc, complexity: cx, weight: w, process: p, effective_date: '2026-03-01' });
    }
  });
  seedAll();
}
