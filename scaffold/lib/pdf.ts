import 'server-only';

/**
 * lib/pdf.ts - the only place that talks to the PDF renderer.
 *
 * The renderer is Gotenberg 8 (deploy/compose.dev.yml), reached at `PDF_URL`. Its HTML route takes a
 * MULTIPART form whose file part must be named `index.html`, and returns `application/pdf`. Page size
 * and margins are form fields, not CSS - Chromium's own print dialogue values.
 *
 * THE HTML MUST BE SELF-CONTAINED. The renderer is a different container on a different network path;
 * it cannot fetch a stylesheet, a font or an image from the app, and a request it cannot satisfy is a
 * blank area on the page rather than an error. So every caller inlines its CSS and embeds its images.
 *
 * PDF_URL in dev is NOT the .env.example default. That default (`http://pdf:3000`) is the service name
 * as another CONTAINER sees it; on a workstation the app runs on the host with `npm run dev`, so it
 * must be the published loopback port - `http://127.0.0.1:3101` for this instance. Getting this wrong
 * produces a bare fetch failure, so the error below says so in as many words.
 *
 * AND IT MUST BE 127.0.0.1, NOT localhost. Node 17 stopped reordering DNS results, so on Windows
 * `localhost` commonly resolves to ::1 first, while compose publishes the port as
 * `127.0.0.1:<port>:3000` - IPv4 only. The connection is then refused on an address nothing listens
 * on, and it reads exactly like a renderer that is down while the container is running perfectly.
 * The refusal below names this, because it costs an hour otherwise.
 */

export class PdfUnavailable extends Error {}

export interface PdfOptions {
  /** A4 in inches, which is what Gotenberg's form fields take. */
  readonly paperWidth?: number;
  readonly paperHeight?: number;
  readonly margin?: number;
  readonly landscape?: boolean;
}

export interface RenderedPdf { readonly bytes: Buffer; readonly renderer: string }

const DEFAULTS: Required<Omit<PdfOptions, 'landscape'>> = { paperWidth: 8.27, paperHeight: 11.69, margin: 0.5 };

export function pdfRendererUrl(): string {
  return (process.env.PDF_URL ?? '').replace(/\/+$/, '');
}

export function pdfTimeoutMs(): number {
  const raw = Number(process.env.PDF_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * Renders one self-contained HTML document to a PDF.
 *
 * Throws PdfUnavailable for anything the caller can act on - no URL configured, the renderer not
 * reachable, a timeout, a non-PDF answer. Callers decide what that means: the freeze logs it and
 * carries on, because a record is a database row and the PDF is a rendering of it.
 */
export async function renderPdf(html: string, opts: PdfOptions = {}): Promise<RenderedPdf> {
  const base = pdfRendererUrl();
  if (!base) {
    throw new PdfUnavailable('PDF_URL is not set. On a workstation it is the published renderer port, e.g. http://127.0.0.1:3101.');
  }
  const o = { ...DEFAULTS, ...opts };

  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('paperWidth', String(o.paperWidth));
  form.append('paperHeight', String(o.paperHeight));
  form.append('marginTop', String(o.margin));
  form.append('marginBottom', String(o.margin));
  form.append('marginLeft', String(o.margin));
  form.append('marginRight', String(o.margin));
  form.append('printBackground', 'true');
  form.append('preferCssPageSize', 'false');
  if (opts.landscape) form.append('landscape', 'true');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pdfTimeoutMs());
  let res: Response;
  try {
    res = await fetch(`${base}/forms/chromium/convert/html`, { method: 'POST', body: form, signal: controller.signal });
  } catch (err) {
    const why = (err as Error).name === 'AbortError'
      ? `the renderer did not answer within ${pdfTimeoutMs()} ms`
      : `the renderer at ${base} could not be reached (${(err as Error).message})`;
    // The localhost / ::1 trap, named where it bites.
    const ipv6Hint = /^https?:\/\/localhost(:|\/|$)/i.test(base)
      ? ' PDF_URL uses "localhost", which on Windows resolves to ::1 while the port is published on 127.0.0.1 only - use http://127.0.0.1:3101.'
      : '';
    throw new PdfUnavailable(`No PDF: ${why}.${ipv6Hint} Is ava-pdf running - docker compose --env-file .env -f deploy/compose.dev.yml up -d pdf?`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new PdfUnavailable(`No PDF: the renderer answered ${res.status}. ${detail}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/pdf')) {
    throw new PdfUnavailable(`No PDF: the renderer answered ${type || 'no content type'} instead of a PDF.`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new PdfUnavailable('No PDF: the renderer returned an empty file.');
  return { bytes, renderer: res.headers.get('gotenberg-trace') ? 'gotenberg/8' : 'gotenberg' };
}

/** Whether the renderer answers its health check. For /api/health and the support page. */
export async function pdfHealthy(): Promise<boolean> {
  const base = pdfRendererUrl();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
