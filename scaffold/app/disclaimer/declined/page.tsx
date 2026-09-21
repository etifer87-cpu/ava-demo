/**
 * Cancel lands here.
 *
 * NOT a 404. A 404 says the page does not exist, which is untrue, and to anyone watching over a
 * shoulder it reads as a broken site rather than a deliberate refusal. This says what actually
 * happened and offers the way back, which is both honest and less alarming in a room.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const metadata = { title: 'Not continued' };

export default function DeclinedPage() {
  return (
    <div className="stack" style={{ maxWidth: '32rem', margin: '0 auto' }}>
      <h1>Not continued</h1>
      <div className="notice">
        <p style={{ margin: 0 }}>
          This demonstration is only available to people who accept the notice.
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          Nothing has been opened and nothing has been recorded. If you reached this by accident you
          can <a href="/disclaimer">read the notice again</a>.
        </p>
      </div>
    </div>
  );
}
