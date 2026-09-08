import Link from 'next/link';

/**
 * 404. Deliberately incurious: it does not distinguish "does not exist" from "exists and is not
 * yours to see". Distinguishing the two is how a list of valid ids gets enumerated.
 */
export default function NotFound() {
  return (
    <div className="empty" data-testid="not-found">
      <p style={{ color: 'var(--ink)', fontWeight: 600 }}>Not found</p>
      <p className="small">This page does not exist, or it is not yours to see.</p>
      <p className="small">
        <Link href="/">Back to the overview</Link>
      </p>
    </div>
  );
}
