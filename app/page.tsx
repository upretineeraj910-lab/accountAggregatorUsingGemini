import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ padding: "3rem 1.5rem", maxWidth: "800px", margin: "0 auto", textAlign: "center" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>LoanSaarthi Internal Tool</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "2rem", fontSize: "1.1rem" }}>
        Bank Statement Analysis & Underwriting Verification System
      </p>
      <Link
        href="/statement"
        style={{
          display: "inline-block",
          padding: "0.75rem 1.75rem",
          backgroundColor: "var(--primary)",
          color: "#fff",
          borderRadius: "6px",
          fontWeight: 600,
        }}
      >
        Go to Statement Check →
      </Link>
    </main>
  );
}
