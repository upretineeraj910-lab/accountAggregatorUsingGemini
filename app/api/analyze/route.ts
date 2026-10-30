import { NextRequest, NextResponse } from "next/server";
import { pdfToLines } from "@/lib/pdfText";
import { extractProfile } from "@/lib/profile";
import { extractWithAi, AiExtractError } from "@/lib/ai/extract";
import { analyze } from "@/lib/analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  // TODO: AUTH GUARD - In production integrated with LoanSaarthi CRM, verify session token/cookie
  // e.g. verify getAuthUser(req) role in ['admin', 'superadmin', 'crm', 'crm_editor', 'crm_entry']
  // const user = await getAuthUser(req);
  // if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const password = (formData.get("password") as string) || undefined;
    const holderName = (formData.get("holderName") as string) || undefined;
    const aiConsent = formData.get("aiConsent");
    const allowFullText = formData.get("allowFullText") === "yes";

    // 1. Validate Consent
    if (aiConsent !== "yes") {
      return NextResponse.json(
        { error: "AI processing consent is required to analyze statement text." },
        { status: 400 }
      );
    }

    // 2. Validate File presence
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: "A valid PDF file is required." },
        { status: 400 }
      );
    }

    // 3. Validate File Size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File size exceeds 10MB limit." },
        { status: 413 }
      );
    }

    // 4. Validate Content Type / Extension
    const mime = file.type || "";
    const name = file.name || "";
    const isPdf =
      mime === "application/pdf" ||
      name.toLowerCase().endsWith(".pdf") ||
      mime === "application/x-pdf";

    if (!isPdf) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 415 }
      );
    }

    // In-memory ArrayBuffer reading
    const arrayBuffer = await file.arrayBuffer();

    // Step 1: PDF to lines
    let lines: string[];
    try {
      lines = await pdfToLines(arrayBuffer, password);
    } catch (pdfErr: unknown) {
      const errName = pdfErr instanceof Error ? pdfErr.name : "";
      if (errName === "PasswordException") {
        return NextResponse.json(
          { needPassword: true, error: "Password protected PDF" },
          { status: 401 }
        );
      }
      console.error("PDF parse error:", errName || "UnknownPdfError");
      return NextResponse.json(
        { error: "Failed to read PDF document text." },
        { status: 400 }
      );
    }

    if (!lines || lines.length === 0) {
      return NextResponse.json(
        { error: "PDF text content appears empty or scanned." },
        { status: 400 }
      );
    }

    // Step 2: Local Profile extraction
    const profile = extractProfile(lines);
    const effectiveHolder = holderName?.trim() || profile.name;

    // Step 3: AI extraction
    const { txns, quality, meta } = await extractWithAi(lines, {
      allowFullTextIfNoHeader: allowFullText,
    });

    // Step 4: Rule-based analysis
    const result = analyze(txns, {
      holderName: effectiveHolder,
      accountNo: profile.accountNo,
      parseQualityOk: quality.ok,
    });

    // Lightweight serializable transactions for client-side recompute
    const serializedTxns = txns.map((t) => ({
      d: t.date.toISOString(),
      n: t.narration,
      dr: t.debit,
      cr: t.credit,
      b: t.balance,
    }));

    const url = new URL(req.url);
    const isDebug =
      url.searchParams.get("debug") === "1" && process.env.NODE_ENV !== "production";

    const responseBody: Record<string, unknown> = {
      profile,
      parseQuality: quality,
      txns: serializedTxns,
      result,
      meta,
    };

    if (isDebug) {
      responseBody.debug = {
        chunksCount: meta.chunks,
        qualityNotes: quality.notes,
      };
    }

    return NextResponse.json(responseBody);
  } catch (err: unknown) {
    if (err instanceof AiExtractError) {
      console.error("AiExtractError:", err.code, "-", err.message);
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 502 }
      );
    }

    const errName = err instanceof Error ? err.name : "InternalError";
    console.error("Analyze API error:", errName);
    return NextResponse.json(
      { error: "An unexpected error occurred during statement analysis." },
      { status: 500 }
    );
  }
}
