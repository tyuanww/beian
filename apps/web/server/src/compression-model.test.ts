import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPRESSION_POLICY,
  PDF_ESTIMATE_HEADROOM_BYTES,
  PDF_TARGET_BYTES,
  compressionPolicyFingerprint,
} from "./compressionPolicy.js";
import {
  COMPRESSION_ERROR_CATALOG,
  decidePdf,
  evaluateCompressionRetry,
  exifOrientedSize,
  firstQualifiedPdfCandidate,
  interpretQpdfExit,
  pdfRoundPlan,
  publicCompressionFile,
  qpdfLosslessArgs,
  rollupCompressionStatus,
} from "./compressionModel.js";

const capability = {
  policyFingerprint: "policy-a",
  toolGeneration: "tools-a",
  ready: true,
  executorFence: false,
};

describe("compression decisions", () => {
  it("stops below 10_000_000 bytes and ignores the 9.8 MB estimate", () => {
    assert.equal(PDF_TARGET_BYTES, 10_000_000);
    assert.equal(PDF_ESTIMATE_HEADROOM_BYTES, 9_800_000);
    assert.equal(firstQualifiedPdfCandidate.toString().includes("9800000"), false);
    assert.deepEqual(firstQualifiedPdfCandidate([9_950_000]), { index: 0, bytes: 9_950_000 });
    assert.equal(firstQualifiedPdfCandidate([10_000_000]), null);
    assert.deepEqual(firstQualifiedPdfCandidate([12_000_000, 9_950_000, 8_000_000]), { index: 1, bytes: 9_950_000 });
    assert.equal(firstQualifiedPdfCandidate([10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000, 1]), null);
    assert.equal(pdfRoundPlan().length, 8);
    assert.deepEqual(pdfRoundPlan()[0], { kind: "lossless" });
    assert.deepEqual(pdfRoundPlan()[7], { kind: "quality", quality: 60 });
  });

  it("does not rewrite signed, restricted, unknown, or warned PDFs", () => {
    const base = {
      readable: true,
      bytes: 10_000_000,
      passwordRequired: false,
      filledSignatures: 0,
      emptySignatureFields: 4,
      docMdp: false,
      signatureUnknown: false,
      stampAnnotations: 2,
      checkWarning: false,
      checkError: false,
    };
    assert.deepEqual(decidePdf(base), { status: "running", reason: null, rewrite: true });
    assert.equal(decidePdf({ ...base, bytes: 9_950_000, filledSignatures: 2, docMdp: true }).status, "passthrough");
    assert.equal(decidePdf({ ...base, passwordRequired: true, bytes: 100 }).reason, "password_required");
    assert.equal(decidePdf({ ...base, checkError: true, bytes: 100 }).reason, "corrupt");
    assert.equal(decidePdf({ ...base, checkWarning: true, bytes: 100 }).reason, "qpdf_warning_unapproved");
    assert.equal(decidePdf({ ...base, signatureUnknown: true }).reason, "signature_unknown");
    assert.equal(decidePdf({ ...base, signatureUnknown: true }).rewrite, false);
    assert.equal(decidePdf({ ...base, filledSignatures: 1 }).reason, "signature_over_limit");
    assert.equal(decidePdf({ ...base, docMdp: true }).reason, "modification_restricted");
  });

  it("interprets qpdf exits without hiding warnings", () => {
    assert.deepEqual(interpretQpdfExit("check", 0), { ok: true });
    assert.equal(interpretQpdfExit("transform", 2).ok, false);
    assert.equal(interpretQpdfExit("check", 3).ok, false);
    assert.deepEqual(interpretQpdfExit("is_encrypted", 0), { ok: true, encrypted: true });
    assert.deepEqual(interpretQpdfExit("is_encrypted", 2), { ok: true, encrypted: false });
    assert.equal(interpretQpdfExit("is_encrypted", 3).ok, false);
    assert.deepEqual(interpretQpdfExit("requires_password", 0), { ok: true, passwordRequired: true });
    assert.deepEqual(interpretQpdfExit("requires_password", 2), { ok: true, passwordRequired: false, encrypted: false });
    assert.deepEqual(interpretQpdfExit("requires_password", 3), { ok: true, passwordRequired: false, encrypted: true });
    const args = qpdfLosslessArgs("in.pdf", "out.pdf");
    assert.equal(args.some((arg) => arg.includes("no-warn") || arg.includes("warning-exit-0") || arg.includes("optimize-images")), false);
  });

  it("normalizes EXIF orientations 1 through 8 and rejects the rest", () => {
    assert.deepEqual(exifOrientedSize(30, 10, null), { width: 30, height: 10 });
    assert.deepEqual(exifOrientedSize(30, 10, 1), { width: 30, height: 10 });
    for (const orientation of [2, 3, 4]) {
      assert.deepEqual(exifOrientedSize(30, 10, orientation), { width: 30, height: 10 });
    }
    for (const orientation of [5, 6, 7, 8]) {
      assert.deepEqual(exifOrientedSize(30, 10, orientation), { width: 10, height: 30 });
    }
    assert.equal(exifOrientedSize(30, 10, 9), null);
  });

  it("keeps the retry matrix and ignores the policy version string", () => {
    const failed = {
      status: "unmet_target" as const,
      reason: "unmet_target",
      manual_retries: 0,
      last_retry_at: null,
      policy_fingerprint: "policy-a",
      tool_generation: "tools-a",
    };
    assert.equal(evaluateCompressionRetry(failed, 10_000, capability).ok, false);
    assert.equal(evaluateCompressionRetry(failed, 10_000, { ...capability, toolGeneration: "tools-b" }).ok, true);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "multi_frame" }, 10_000, { ...capability, toolGeneration: "tools-b" }).ok, false);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "dependency_missing" }, 10_000, { ...capability, ready: false }).ok, false);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "dependency_missing" }, 10_000, capability).ok, true);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "interrupted" }, 10_000, { ...capability, executorFence: true }).ok, false);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "interrupted", last_retry_at: new Date(0).toISOString() }, 10_000, capability).ok, false);
    assert.equal(evaluateCompressionRetry({ ...failed, reason: "interrupted", last_retry_at: new Date(0).toISOString() }, 31_000, capability).ok, true);
    assert.equal(evaluateCompressionRetry({ ...failed, manual_retries: 3, reason: "interrupted" }, 99_000, capability).ok, false);
    const renamed = compressionPolicyFingerprint({ ...COMPRESSION_POLICY, version: "renamed-only" });
    assert.equal(renamed, compressionPolicyFingerprint());
    assert.notEqual(compressionPolicyFingerprint({ ...COMPRESSION_POLICY, pdf_min_quality: 61 }), renamed);
    const codes = COMPRESSION_ERROR_CATALOG.map((item) => item.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("rolls up batches and hides bytes that cannot be downloaded", () => {
    assert.equal(rollupCompressionStatus([{ status: "running" }, { status: "queued" }]), "running");
    assert.equal(rollupCompressionStatus([{ status: "queued" }, { status: "failed" }]), "queued");
    assert.equal(rollupCompressionStatus([{ status: "succeeded" }, { status: "passthrough" }]), "done");
    assert.equal(rollupCompressionStatus([{ status: "succeeded" }, { status: "unmet_target" }]), "partial");
    assert.equal(rollupCompressionStatus([{ status: "failed" }, { status: "unsupported" }]), "failed");
    const hidden = publicCompressionFile({
      id: "asset1",
      name: "a.pdf",
      media_type: "application/pdf",
      status: "unmet_target",
      input_bytes: 12,
      output_bytes: 0,
      reason: "unmet_target",
      key: "file-asset1",
      can_retry: false,
    });
    assert.equal(hidden.output_bytes, null);
    assert.equal(hidden.key, null);
    assert.equal(hidden.target_bytes, 10_000_000);
    const image = publicCompressionFile({
      ...hidden,
      media_type: "image/jpeg",
      status: "passthrough",
      output_bytes: 4,
      key: "file-asset1",
    });
    assert.equal(image.target_bytes, null);
    assert.equal(image.output_bytes, 4);
  });
});
