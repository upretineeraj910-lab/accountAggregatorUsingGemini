"use client";

import React, { useState, useMemo } from "react";
import styles from "./page.module.css";
import { Profile, AiQuality, AnalysisResult, Txn } from "@/lib/types";
import { analyze } from "@/lib/analyze";
import { checkNewLoan } from "@/lib/loanCheck";

interface SerializedTxn {
  d: string;
  n: string;
  dr: number;
  cr: number;
  b: number;
}

export default function StatementPage() {
  // Form States
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [holderName, setHolderName] = useState("");
  const [aiConsent, setAiConsent] = useState(false);
  const [allowFullText, setAllowFullText] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);

  // Analysis Response State
  const [profile, setProfile] = useState<Profile | null>(null);
  const [parseQuality, setParseQuality] = useState<AiQuality | null>(null);
  const [rawTxns, setRawTxns] = useState<SerializedTxn[]>([]);

  // Client-side Overrides & Recompute State
  const [excludedSalaryKeys, setExcludedSalaryKeys] = useState<Set<string>>(new Set());
  const [manualSalaryInput, setManualSalaryInput] = useState<string>("");

  // New Loan Calculator State
  const [loanAmount, setLoanAmount] = useState<number>(500000);
  const [loanRate, setLoanRate] = useState<number>(14);
  const [loanTenureYears, setLoanTenureYears] = useState<number>(5);

  // Phase 8 AI summary state
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [loadingAiSummary, setLoadingAiSummary] = useState(false);

  // Handle Form Submission
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Kripya ek PDF statement file chunein.");
      return;
    }
    if (!aiConsent) {
      setError("AI consent zaroori hai statement analyze karne ke liye.");
      return;
    }

    setLoading(true);
    setError(null);
    setNeedPassword(false);
    setAiSummary(null);

    const formData = new FormData();
    formData.append("file", file);
    if (password) formData.append("password", password);
    if (holderName) formData.append("holderName", holderName);
    formData.append("aiConsent", "yes");
    if (allowFullText) formData.append("allowFullText", "yes");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401 && data.needPassword) {
          setNeedPassword(true);
          setError("PDF password-protected hai. Kripya password darj karein.");
        } else {
          setError(data.error || `Server error (${res.status})`);
        }
        setLoading(false);
        return;
      }

      setProfile(data.profile || {});
      setParseQuality(data.parseQuality || null);
      setRawTxns(data.txns || []);
      setExcludedSalaryKeys(new Set());
      setManualSalaryInput("");

      if (data.profile?.name && !holderName) {
        setHolderName(data.profile.name);
      }
    } catch {
      setError("Network ya API request mein error aayi.");
    } finally {
      setLoading(false);
    }
  }

  // Convert serialized transactions back to Txn instances for browser-side recompute
  const parsedTxns: Txn[] = useMemo(() => {
    return rawTxns.map((t) => ({
      date: new Date(t.d),
      narration: t.n,
      debit: t.dr,
      credit: t.cr,
      balance: t.b,
    }));
  }, [rawTxns]);

  // Pure browser-side recomputation of AnalysisResult on any override change
  const currentAnalysis: AnalysisResult | null = useMemo(() => {
    if (parsedTxns.length === 0) return null;

    const manualVal = parseFloat(manualSalaryInput);
    const manualSalary = !isNaN(manualVal) && manualVal > 0 ? manualVal : undefined;

    return analyze(parsedTxns, {
      holderName: holderName.trim() || profile?.name,
      accountNo: profile?.accountNo,
      excludedSalaryIds: excludedSalaryKeys,
      manualSalary,
      parseQualityOk: parseQuality?.ok ?? true,
    });
  }, [parsedTxns, holderName, profile, excludedSalaryKeys, manualSalaryInput, parseQuality]);

  // Interactive New Loan Check calculation
  const newLoanResult = useMemo(() => {
    if (!currentAnalysis || currentAnalysis.avgSalary <= 0) return null;
    return checkNewLoan({
      avgSalary: currentAnalysis.avgSalary,
      monthlyEmi: currentAnalysis.currentEmi,
      amount: loanAmount,
      ratePct: loanRate,
      tenureMonths: loanTenureYears * 12,
    });
  }, [currentAnalysis, loanAmount, loanRate, loanTenureYears]);

  // Toggle Salary Credit Inclusion
  function toggleSalaryCredit(txn: Txn, index: number) {
    const key = `${txn.date.toISOString()}_${txn.credit}_${index}`;
    setExcludedSalaryKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // Request Optional AI Summary (Phase 8)
  async function fetchAiSummary() {
    if (!currentAnalysis) return;
    setLoadingAiSummary(true);
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          avgSalary: currentAnalysis.avgSalary,
          monthlyEmi: currentAnalysis.currentEmi,
          foir: currentAnalysis.foir,
          bouncesCount: currentAnalysis.risks.bouncesCount,
          cashPct: currentAnalysis.cashDeposits.pctOfCredits,
          passThroughPct: currentAnalysis.risks.passThroughPct,
          selfNet: currentAnalysis.credits.selfNet,
          roundTripCount: currentAnalysis.roundTrip.count,
          medianDailyBalance: currentAnalysis.balances.medianDailyBalance,
          minBalance: currentAnalysis.balances.minBalance,
        }),
      });
      const data = await res.json();
      if (res.ok && data.summary) {
        setAiSummary(data.summary);
      } else {
        setAiSummary("AI summary uplabdh nahi hai (Feature disabled ya server issue).");
      }
    } catch {
      setAiSummary("AI summary load karne mein takleef aayi.");
    } finally {
      setLoadingAiSummary(false);
    }
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <h1 className={styles.title}>
          Statement Check <span className={styles.badgeDsa}>LoanSaarthi Internal</span>
        </h1>
        <p className={styles.subtitle}>
          Bank statement underwriting, balance chain verification, and risk signal forensics.
        </p>
      </header>

      {/* Upload & Options Form */}
      <div className={styles.formCard}>
        <form onSubmit={handleSubmit}>
          <div className={styles.formGrid}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Bank Statement PDF *</label>
              <input
                type="file"
                accept=".pdf,application/pdf"
                className={styles.input}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label}>PDF Password (agar encrypted hai)</label>
              <input
                type="password"
                placeholder="Protected PDF password"
                value={password}
                className={`${styles.input} ${needPassword ? styles.inputHighlight : ""}`}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label}>Account Holder ka Naam (Self-transfer check)</label>
              <input
                type="text"
                placeholder="e.g. RAJESH KUMAR"
                value={holderName}
                className={styles.input}
                onChange={(e) => setHolderName(e.target.value)}
              />
            </div>
          </div>

          <label className={styles.checkboxContainer}>
            <input
              type="checkbox"
              checked={aiConsent}
              onChange={(e) => setAiConsent(e.target.checked)}
              required
            />
            <span>
              Is statement ka table text AI service (Google Gemini) ko bheja jayega. Client ka consent liya hai.
            </span>
          </label>

          <label className={styles.checkboxContainer}>
            <input
              type="checkbox"
              checked={allowFullText}
              onChange={(e) => setAllowFullText(e.target.checked)}
            />
            <span style={{ color: "var(--text-muted)" }}>
              Advanced: Header detect na ho to poora text bhejne do (naam/address bhi jayega)
            </span>
          </label>

          <button type="submit" disabled={loading} className={styles.btnSubmit}>
            {loading ? "Padh raha hu..." : "Check karo"}
          </button>
        </form>
      </div>

      {/* Error Message */}
      {error && <div className={styles.alertError}>{error}</div>}

      {/* Analysis Reports */}
      {currentAnalysis && (
        <div>
          {/* Section 1: Client & Account Profile */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>1. Client & Account Profile</h2>
              <span className={styles.badgeDsa}>Parser: AI</span>
            </div>

            {parseQuality && !parseQuality.ok && (
              <div className={styles.alertError} style={{ marginBottom: "1rem" }}>
                <strong>Parsing pakki nahi, numbers manually verify karo:</strong>
                <ul style={{ marginLeft: "1.25rem", marginTop: "0.35rem" }}>
                  {parseQuality.notes.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.metricsGrid}>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Account Holder</div>
                <div className={styles.metricValue}>{holderName || profile?.name || "—"}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Account Number</div>
                <div className={styles.metricValue}>{profile?.accountNo || "—"}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Branch & IFSC</div>
                <div className={styles.metricValue}>
                  {profile?.branch || "—"}
                  <div className={styles.metricSub}>{profile?.ifsc || "—"}</div>
                </div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Statement Period</div>
                <div className={styles.metricValue}>
                  {currentAnalysis.txnPeriod.start.toLocaleDateString("en-IN")} -{" "}
                  {currentAnalysis.txnPeriod.end.toLocaleDateString("en-IN")}
                </div>
                <div className={styles.metricSub}>{currentAnalysis.txnPeriod.totalDays} Days ({rawTxns.length} txns)</div>
              </div>
            </div>
          </div>

          {/* Section 2: Verdict & Score */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>2. Underwriting Verdict & Score</h2>
            </div>
            <div className={styles.scoreGrid}>
              <div
                className={`${styles.scoreCircle} ${
                  currentAnalysis.verdict === "Strong"
                    ? styles.scoreStrong
                    : currentAnalysis.verdict === "Average"
                    ? styles.scoreAverage
                    : styles.scoreWeak
                }`}
              >
                <div className={styles.scoreNum}>{currentAnalysis.score}</div>
                <div className={styles.scoreMax}>/ 100</div>
              </div>
              <div>
                <span
                  className={`${styles.verdictBadge} ${
                    currentAnalysis.verdict === "Strong"
                      ? styles.badgeStrong
                      : currentAnalysis.verdict === "Average"
                      ? styles.badgeAverage
                      : styles.badgeWeak
                  }`}
                >
                  Verdict: {currentAnalysis.verdict}
                </span>
                <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
                  Indicative score hai, final decision bank ka hota hai.
                </p>
                {currentAnalysis.salaryShareLow && (
                  <div className={styles.alertWarning} style={{ marginTop: "0.75rem", padding: "0.6rem" }}>
                    ⚠️ Warning: Salary share credit inflow ka 40% se kam hai ({currentAnalysis.credits.salaryPct}%).
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Section 3: Salary Card (Sabse upar, Bada) */}
          <div className={`${styles.sectionCard} ${styles.salaryHero}`}>
            <div className={styles.salaryHeaderRow}>
              <div>
                <div className={styles.metricLabel}>Average Monthly Salary</div>
                <div className={styles.salaryBigAmt}>
                  ₹{currentAnalysis.avgSalary.toLocaleString("en-IN")}
                  <span style={{ fontSize: "1rem", color: "var(--text-muted)", fontWeight: 500 }}> / mahina</span>
                </div>
                <div className={styles.salaryMeta}>
                  Sender: <strong>{currentAnalysis.salary.sender || "Identified via Narration"}</strong> |
                  Method: <span className={styles.badgeDsa}>{currentAnalysis.salary.method}</span> |
                  Months: {currentAnalysis.salary.months}
                </div>
              </div>

              <div style={{ maxWidth: "260px" }}>
                <label className={styles.label}>Salary manually daalo (Override):</label>
                <input
                  type="number"
                  placeholder="e.g. 50000"
                  className={styles.input}
                  value={manualSalaryInput}
                  onChange={(e) => setManualSalaryInput(e.target.value)}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Browser mein turant recompute hoga.
                </span>
              </div>
            </div>

            {/* Salary Credits Table */}
            <div style={{ marginTop: "1.25rem" }}>
              <div className={styles.label} style={{ marginBottom: "0.5rem" }}>
                Mahine-wise Salary Credits (Untick karke hatao):
              </div>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Shamil</th>
                      <th>Tareekh</th>
                      <th>Narration</th>
                      <th>Amount (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedTxns
                      .filter((t) => t.credit > 0)
                      .map((t, idx) => {
                        const key = `${t.date.toISOString()}_${t.credit}_${idx}`;
                        const isIncluded = !excludedSalaryKeys.has(key);
                        const isChosenSalary = currentAnalysis.salary.credits.includes(t);
                        if (!isChosenSalary && !excludedSalaryKeys.has(key)) return null;

                        return (
                          <tr key={key}>
                            <td>
                              <input
                                type="checkbox"
                                checked={isIncluded}
                                onChange={() => toggleSalaryCredit(t, idx)}
                              />
                            </td>
                            <td>{t.date.toLocaleDateString("en-IN")}</td>
                            <td>{t.narration}</td>
                            <td><strong>₹{t.credit.toLocaleString("en-IN")}</strong></td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {/* Extra credits (Arrears / Bonus) */}
              {currentAnalysis.salary.extraCredits.length > 0 && (
                <div style={{ marginTop: "1rem" }}>
                  <div className={styles.label} style={{ color: "var(--warning)" }}>
                    Extra Credits / Arrears / Bonus (Average mein shamil nahi):
                  </div>
                  <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginLeft: "1.25rem" }}>
                    {currentAnalysis.salary.extraCredits.map((ec, i) => (
                      <li key={i}>
                        {ec.date.toLocaleDateString("en-IN")}: ₹{ec.credit.toLocaleString("en-IN")} ({ec.narration})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Section 4: Metrics Grid */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>4. Underwriting Metrics Grid</h2>
            </div>
            <div className={styles.metricsGrid}>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Monthly EMI</div>
                <div className={styles.metricValue}>₹{currentAnalysis.currentEmi.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Poore mahine: {currentAnalysis.monthsUsed.join(", ")}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>FOIR Ratio</div>
                <div className={styles.metricValue}>{currentAnalysis.foir}%</div>
                <div className={styles.metricSub}>
                  {currentAnalysis.foir <= 45 ? "Safe (<=45%)" : currentAnalysis.foir <= 50 ? "Borderline" : "High Risk"}
                </div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Bounces / Returns</div>
                <div className={styles.metricValue} style={{ color: currentAnalysis.risks.bouncesCount > 0 ? "var(--danger)" : "inherit" }}>
                  {currentAnalysis.risks.bouncesCount}
                </div>
                <div className={styles.metricSub}>{currentAnalysis.risks.bouncesCount === 0 ? "Clean track" : "Immediate review"}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Cash Deposit %</div>
                <div className={styles.metricValue}>{currentAnalysis.cashDeposits.pctOfCredits}%</div>
                <div className={styles.metricSub}>Total: ₹{currentAnalysis.cashDeposits.total.toLocaleString("en-IN")}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Median Daily Balance</div>
                <div className={styles.metricValue}>₹{currentAnalysis.balances.medianDailyBalance.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Day-end carry forward balance</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Min Balance & Low Days</div>
                <div className={styles.metricValue}>₹{currentAnalysis.balances.minBalance.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>{currentAnalysis.balances.daysAtOrBelow500} din balance &le; ₹500</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Month-End Avg</div>
                <div className={styles.metricValue}>₹{currentAnalysis.balances.monthEndAvgBalance.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Month-end balance average</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Avg Txn Balance</div>
                <div className={styles.metricValue}>₹{currentAnalysis.balances.avgTxnBalance.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Overall running avg</div>
              </div>
            </div>
          </div>

          {/* Section 5: Obligations Table */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>5. Obligations & EMI Breakdown</h2>
            </div>

            {currentAnalysis.obligations.partialRecoveries.length > 0 && (
              <div className={styles.alertWarning}>
                ⚠️ Partial EMI recovery detected on due dates:{" "}
                {currentAnalysis.obligations.partialRecoveries.map((p, idx) => (
                  <span key={idx}>
                    {p.key} ({p.count} event(s)){idx < currentAnalysis.obligations.partialRecoveries.length - 1 ? ", " : ""}
                  </span>
                ))}
              </div>
            )}

            <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
              Cash deposited within 2 days prior to EMI:{" "}
              <strong>
                {currentAnalysis.obligations.cashBeforeEmiCount}/{currentAnalysis.obligations.totalEmiDebits}
              </strong>
            </p>

            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Loan / Lender Label</th>
                    <th>Typical EMI (₹)</th>
                    <th>Months Seen</th>
                    <th>Last Date</th>
                    <th>Monthly Totals</th>
                  </tr>
                </thead>
                <tbody>
                  {currentAnalysis.obligations.items.map((ob, idx) => (
                    <tr key={idx}>
                      <td><strong>{ob.label}</strong></td>
                      <td>₹{ob.typicalAmount.toLocaleString("en-IN")}</td>
                      <td>{ob.monthsSeen}</td>
                      <td>{ob.lastDate.toLocaleDateString("en-IN")}</td>
                      <td>
                        {Object.entries(ob.monthlyTotals)
                          .map(([m, amt]) => `${m}: ₹${amt.toLocaleString("en-IN")}`)
                          .join(" | ")}
                      </td>
                    </tr>
                  ))}
                  {currentAnalysis.obligations.items.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)" }}>
                        Koi regular loan ya EMI debit nahi mila.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Insurance Breakdown */}
            {currentAnalysis.obligations.insuranceItems.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <div className={styles.label}>Insurance Policies Serviced (EMI se alag):</div>
                <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginLeft: "1.25rem" }}>
                  {currentAnalysis.obligations.insuranceItems.map((ins, i) => (
                    <li key={i}>
                      {ins.date.toLocaleDateString("en-IN")}: ₹{ins.amount.toLocaleString("en-IN")} ({ins.label})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Section 6: Credits Classification */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>6. Credits Classification & Counterparties</h2>
            </div>

            {/* Banners */}
            {currentAnalysis.risks.lendingAppsCount > 0 && (
              <div className={styles.alertWarning}>
                ⚠️ Fintech Lending Apps Detected: {currentAnalysis.risks.lendingAppsCount} txn(s) amounting to ₹
                {currentAnalysis.risks.lendingAppsTotal.toLocaleString("en-IN")}.
              </div>
            )}

            {currentAnalysis.credits.pctOfTotalCredit > 20 && currentAnalysis.credits.selfIn > 0 && (
              <div className={styles.alertWarning}>
                ⚠️ High Self-Transfer: Self inflow is ₹{currentAnalysis.credits.selfIn.toLocaleString("en-IN")}.
              </div>
            )}

            {/* Chips */}
            <div className={styles.chipsContainer}>
              {Object.entries(currentAnalysis.credits.byCategory).map(([cat, data]) => (
                <div key={cat} className={styles.chip}>
                  <span>{cat}</span>
                  <span className={styles.chipCount}>{data.count}</span>
                  <span style={{ color: "var(--text-muted)" }}>₹{data.total.toLocaleString("en-IN")}</span>
                </div>
              ))}
            </div>

            {/* Classified Credits Table */}
            <div className={styles.tableWrapper} style={{ maxHeight: "320px" }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Tareekh</th>
                    <th>Category</th>
                    <th>Risk</th>
                    <th>Amount (₹)</th>
                    <th>Narration</th>
                  </tr>
                </thead>
                <tbody>
                  {currentAnalysis.credits.items.map((it, idx) => (
                    <tr
                      key={idx}
                      className={
                        it.risk === "high"
                          ? styles.rowHighRisk
                          : it.risk === "medium"
                          ? styles.rowMediumRisk
                          : ""
                      }
                    >
                      <td>{it.txn.date.toLocaleDateString("en-IN")}</td>
                      <td><strong>{it.category}</strong></td>
                      <td>{it.risk.toUpperCase()}</td>
                      <td>₹{it.txn.credit.toLocaleString("en-IN")}</td>
                      <td>{it.txn.narration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Counterparties & Large Debits */}
            <div style={{ marginTop: "1.5rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <div className={styles.label} style={{ marginBottom: "0.35rem" }}>Top Credit Senders:</div>
                <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  {currentAnalysis.topCreditSenders.map((cs, i) => (
                    <li key={i}>
                      {cs.name}: ₹{cs.total.toLocaleString("en-IN")} ({cs.count} txns)
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className={styles.label} style={{ marginBottom: "0.35rem" }}>Top Debit Receivers:</div>
                <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  {currentAnalysis.topDebitReceivers.map((dr, i) => (
                    <li key={i}>
                      {dr.name}: ₹{dr.total.toLocaleString("en-IN")} ({dr.count} txns)
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Unclassified Large Debits ("Client se poochho") */}
            {currentAnalysis.unclassifiedLargeDebits.length > 0 && (
              <div style={{ marginTop: "1.25rem" }}>
                <div className={styles.label} style={{ color: "var(--warning)" }}>
                  Client se poochho (Unclassified Large Debits &ge; ₹5,000):
                </div>
                <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginLeft: "1.25rem" }}>
                  {currentAnalysis.unclassifiedLargeDebits.map((d, i) => (
                    <li key={i}>
                      {d.date.toLocaleDateString("en-IN")}: ₹{d.debit.toLocaleString("en-IN")} ({d.narration})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Section 7: Cash Analysis */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>7. Cash Transactions Analysis</h2>
            </div>
            <div className={styles.metricsGrid}>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Cash Deposits Total</div>
                <div className={styles.metricValue}>₹{currentAnalysis.cashDeposits.total.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>{currentAnalysis.cashDeposits.count} deposits ({currentAnalysis.cashDeposits.pctOfCredits}% of credits)</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Cash Withdrawals Total</div>
                <div className={styles.metricValue}>₹{currentAnalysis.cashWithdrawals.total.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>{currentAnalysis.cashWithdrawals.count} withdrawals (ATM/Branch)</div>
              </div>
            </div>
          </div>

          {/* Section 8: Self-Transfer & Rotation */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>8. Self-Transfer & Round-Trip Rotation</h2>
            </div>
            <div className={styles.metricsGrid}>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Self Inflow (Credits)</div>
                <div className={styles.metricValue}>₹{currentAnalysis.credits.selfIn.toLocaleString("en-IN")}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Self Outflow (Debits)</div>
                <div className={styles.metricValue}>₹{currentAnalysis.credits.selfOut.toLocaleString("en-IN")}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Net Self Movement</div>
                <div className={styles.metricValue}>₹{currentAnalysis.credits.selfNet.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Outflow minus Inflow</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Real Adjusted Credit</div>
                <div className={styles.metricValue}>₹{currentAnalysis.credits.realAdjustedCredit.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Credits - Self - Wallet</div>
              </div>
            </div>

            {/* Round trip table */}
            {currentAnalysis.roundTrip.pairs.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <div className={styles.label}>
                  Suspected Round-Trip / Circular Pairs ({currentAnalysis.roundTrip.count} pairs, ₹{currentAnalysis.roundTrip.volume.toLocaleString("en-IN")}):
                </div>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Debit Tareekh</th>
                        <th>Credit Tareekh</th>
                        <th>Amount (₹)</th>
                        <th>Days Gap</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentAnalysis.roundTrip.pairs.map((p, idx) => (
                        <tr key={idx}>
                          <td>{p.debit.date.toLocaleDateString("en-IN")}</td>
                          <td>{p.credit.date.toLocaleDateString("en-IN")}</td>
                          <td>₹{p.amount.toLocaleString("en-IN")}</td>
                          <td>{p.daysDiff} day(s)</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Section 9: Risk Signals */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>9. Key Risk Signals</h2>
            </div>
            <div className={styles.metricsGrid}>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Pass-Through Behavior</div>
                <div className={styles.metricValue} style={{ color: currentAnalysis.risks.passThroughPct >= 50 ? "var(--danger)" : "inherit" }}>
                  {currentAnalysis.risks.passThroughPct}%
                </div>
                <div className={styles.metricSub}>Salary drained in &le;3 days</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Avg Pre-Salary Balance</div>
                <div className={styles.metricValue}>₹{currentAnalysis.balances.avgPreSalaryBalance.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Balance right before salary credit</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Credit Card Bill Servicing</div>
                <div className={styles.metricValue}>₹{currentAnalysis.risks.creditCardPaymentsTotal.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>Card-like: ₹{currentAnalysis.risks.cardLikeTotal.toLocaleString("en-IN")}</div>
              </div>
              <div className={styles.metricBox}>
                <div className={styles.metricLabel}>Market / Speculative Net</div>
                <div className={styles.metricValue}>₹{currentAnalysis.risks.market.net.toLocaleString("en-IN")}</div>
                <div className={styles.metricSub}>{currentAnalysis.risks.market.transfers} broker transfers (SIP: ₹{currentAnalysis.risks.market.sip.toLocaleString("en-IN")})</div>
              </div>
            </div>
          </div>

          {/* Section 10: Evaluation Factors */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>10. Score Evaluation Factors</h2>
            </div>
            <div className={styles.factorsList}>
              {currentAnalysis.factors.map((f, idx) => (
                <div
                  key={idx}
                  className={`${styles.factorItem} ${
                    f.type === "negative"
                      ? styles.factorNegative
                      : f.type === "positive"
                      ? styles.factorPositive
                      : styles.factorInfo
                  }`}
                >
                  <span>
                    {f.type === "positive" ? "✓ " : f.type === "negative" ? "✗ " : "ℹ "}
                    {f.text}
                  </span>
                  {typeof f.points === "number" && (
                    <span className={`${styles.pointsBadge} ${styles.pointsNegative}`}>
                      {f.points} pts
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Section 11: Month-wise Table */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>11. Month-wise Financial Breakdown</h2>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Credits (₹)</th>
                    <th>Debits (₹)</th>
                    <th>Net Inflow (₹)</th>
                    <th>Closing Balance (₹)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {currentAnalysis.monthly.map((m, idx) => (
                    <tr key={idx}>
                      <td><strong>{m.label}</strong></td>
                      <td>₹{m.credit.toLocaleString("en-IN")}</td>
                      <td>₹{m.debit.toLocaleString("en-IN")}</td>
                      <td>₹{(m.credit - m.debit).toLocaleString("en-IN")}</td>
                      <td>₹{m.closingBalance.toLocaleString("en-IN")}</td>
                      <td>
                        {m.isPartial ? (
                          <span style={{ color: "var(--warning)", fontWeight: 600 }}>Partial Month</span>
                        ) : (
                          <span style={{ color: "var(--success)" }}>Full Month</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 12: Interactive New Loan Check */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>12. New Loan Check & Headroom</h2>
            </div>

            <div className={styles.calcGrid}>
              <div className={styles.calcInputs}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Proposed Loan Amount (₹):</label>
                  <input
                    type="number"
                    value={loanAmount}
                    className={styles.input}
                    onChange={(e) => setLoanAmount(parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Interest Rate (% p.a.):</label>
                  <input
                    type="number"
                    value={loanRate}
                    className={styles.input}
                    onChange={(e) => setLoanRate(parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Tenure (Years):</label>
                  <input
                    type="number"
                    value={loanTenureYears}
                    className={styles.input}
                    onChange={(e) => setLoanTenureYears(parseFloat(e.target.value) || 0)}
                  />
                </div>
              </div>

              {newLoanResult && (
                <div className={styles.calcResults}>
                  <div className={styles.foirCompareRow}>
                    <div>
                      <div className={styles.metricLabel}>Abhi ka FOIR</div>
                      <div className={styles.metricValue}>{newLoanResult.currentFoir}%</div>
                    </div>
                    <div style={{ fontSize: "1.5rem", color: "var(--text-muted)" }}>&rarr;</div>
                    <div>
                      <div className={styles.metricLabel}>Naye Loan ke Baad FOIR</div>
                      <div className={styles.metricValue}>{newLoanResult.newFoir}%</div>
                      <span
                        className={`${styles.verdictBadge} ${
                          newLoanResult.status === "Pass"
                            ? styles.badgeStrong
                            : newLoanResult.status === "Borderline"
                            ? styles.badgeAverage
                            : styles.badgeWeak
                        }`}
                        style={{ marginTop: "0.25rem" }}
                      >
                        {newLoanResult.status}
                      </span>
                    </div>
                  </div>

                  <div style={{ fontSize: "0.875rem" }}>
                    <div>New Loan EMI: <strong>₹{newLoanResult.newEmi.toLocaleString("en-IN")}</strong> / mo</div>
                    <div>Total New EMI: <strong>₹{newLoanResult.totalEmi.toLocaleString("en-IN")}</strong> / mo</div>
                    <div>Max Loan Capacity (at 50% FOIR): <strong>₹{newLoanResult.maxLoanAmount.toLocaleString("en-IN")}</strong></div>
                  </div>

                  {newLoanResult.currentFoir <= 45 && newLoanResult.newFoir > 50 && (
                    <div className={styles.alertWarning} style={{ padding: "0.5rem", fontSize: "0.8rem" }}>
                      ⚠️ Abhi FOIR theek hai par naya loan lene ke baad FOIR limit (&gt;50%) cross ho jayegi.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Phase 8: Optional AI Summary Button & Display */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>AI Summary (Indicative)</h2>
              <button
                type="button"
                onClick={fetchAiSummary}
                disabled={loadingAiSummary}
                className={styles.btnSubmit}
                style={{ padding: "0.4rem 0.85rem", fontSize: "0.85rem" }}
              >
                {loadingAiSummary ? "Summarizing..." : "AI summary mango"}
              </button>
            </div>
            {aiSummary ? (
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem", color: "var(--text-main)", lineHeight: 1.6 }}>
                {aiSummary}
              </div>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                AI Summary mein sirf numeric indicators ka summary nikalta hai (Rule verdict hamesha final rehta hai).
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
