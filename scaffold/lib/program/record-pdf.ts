import 'server-only';
import { createHash } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { renderPdf, PdfUnavailable } from '@/lib/pdf';
import { recordHtml, type RecordForPrint } from './record-html';

/**
 * lib/program/record-pdf.ts - rendering a record to a PDF, and keeping the one that was rendered.
 *
 * The PDF is produced AT FINALISATION and stored (migration 0152), so the paper is part of what was
 * frozen rather than something re-made later from whatever the code does that day. A renderer lays a
 * page out slightly differently between versions; a record that was signed should not quietly change
 * shape because the container was upgraded.
 *
 * A FAILED RENDER NEVER FAILS A FINALISE. The record is the regulatory artefact - rows in `records`
 * and its children, with a content hash the signatures attest to. The PDF is a rendering of it. If
 * ava-pdf is down at that moment the record is still written, and the download link renders it then
 * and stores it, which is why `ensureRecordPdf` exists as well as `storeRecordPdf`.
 */

export interface StoredPdf { readonly bytes: Buffer; readonly sha256: string; readonly byteSize: number; readonly renderedAt: string }

/** The record in the shape the print template needs. Null when there is no such live record. */
export async function recordForPrint(recordId: string): Promise<(RecordForPrint & { person_id: string; template_code: string | null; external_id: string | null }) | null> {
  return queryOne<RecordForPrint & { person_id: string; template_code: string | null; external_id: string | null }>(
    `SELECT r.id::text AS id, r.person_id::text AS person_id, r.training_date::text AS training_date, r.title,
            r.outcome, r.outcome_override, r.is_hidden_from_subject, r.content_hash, r.snapshot,
            t.code AS template_code, p.external_id
       FROM records r
       LEFT JOIN people p ON p.id = r.person_id
       LEFT JOIN session_template_versions v ON v.id = r.template_version_id
       LEFT JOIN session_templates t ON t.id = v.template_id
      WHERE r.id = $1::uuid AND r.deleted_at IS NULL`,
    [recordId],
  );
}

/** The stored PDF, or null when none has been rendered yet. */
export async function getRecordPdf(recordId: string): Promise<StoredPdf | null> {
  const row = await queryOne<{ bytes: Buffer; sha256: string; byte_size: string; rendered_at: string }>(
    `SELECT bytes, sha256, byte_size::text AS byte_size, rendered_at::text AS rendered_at
       FROM record_pdfs WHERE record_id = $1::uuid`,
    [recordId],
  );
  if (!row) return null;
  return { bytes: row.bytes, sha256: row.sha256, byteSize: Number(row.byte_size), renderedAt: row.rendered_at };
}

/**
 * Renders the record and stores the result, replacing any previous file.
 *
 * Throws PdfUnavailable when the renderer cannot produce one - the caller decides whether that is
 * fatal. Nothing about the RECORD changes here: this writes only `record_pdfs`.
 */
export async function storeRecordPdf(recordId: string, userId: string | null): Promise<StoredPdf> {
  const rec = await recordForPrint(recordId);
  if (!rec) throw new PdfUnavailable('That record no longer exists.');

  const { bytes, renderer } = await renderPdf(recordHtml(rec));
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  await query(
    `INSERT INTO record_pdfs (record_id, bytes, byte_size, sha256, renderer, rendered_at, rendered_by)
     VALUES ($1::uuid, $2, $3, $4, $5, now(), $6::uuid)
     ON CONFLICT (record_id) DO UPDATE
        SET bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size, sha256 = EXCLUDED.sha256,
            renderer = EXCLUDED.renderer, rendered_at = now(), rendered_by = EXCLUDED.rendered_by`,
    [recordId, bytes, bytes.length, sha256, renderer, userId],
  );
  return { bytes, sha256, byteSize: bytes.length, renderedAt: new Date().toISOString() };
}

/** The stored PDF, rendering and storing one first if there is none. */
export async function ensureRecordPdf(recordId: string, userId: string | null): Promise<StoredPdf> {
  return (await getRecordPdf(recordId)) ?? (await storeRecordPdf(recordId, userId));
}

/**
 * The download name. Operator prefix, employee id, date, program code - so a folder of these sorts by
 * pilot and then by date, which is how a training office looks for one.
 */
export function recordFileName(rec: { external_id: string | null; training_date: string; template_code: string | null }, prefix: string): string {
  const parts = [prefix, rec.external_id ?? 'record', rec.training_date, rec.template_code ?? '']
    .filter((x) => x !== '')
    .map((x) => String(x).replace(/[^A-Za-z0-9._-]+/g, '-'));
  return `${parts.join('_')}.pdf`;
}
