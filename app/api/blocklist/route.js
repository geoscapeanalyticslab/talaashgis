import { NextResponse } from 'next/server';
import { store } from '../../../lib/blobs';

export const dynamic = 'force-dynamic';

function storeError(err){
  console.error('Blob store error:', err.message);
  const hint = /environment has not been configured/i.test(err.message)
    ? ' (Netlify Blobs isn\'t available — run via `netlify dev` locally, or deploy to Netlify.)'
    : '';
  return NextResponse.json({ error: 'Storage backend unavailable.' + hint }, { status: 503 });
}

// GET ?status=pending|approved|rejected|all (default: all)
export async function GET(request){
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'all';

  try {
    const s = store();
    const { blobs } = await s.list({ prefix: 'blocklist:' });
    let entries = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
    entries = entries.filter(Boolean);
    if(status !== 'all') entries = entries.filter(e => e.status === status);
    entries.sort((a, b) => (b.lastReportedAt || 0) - (a.lastReportedAt || 0));
    return NextResponse.json({ entries });
  } catch (err) {
    return storeError(err);
  }
}

// PATCH { key, status: 'approved' | 'rejected' | 'pending' }
export async function PATCH(request){
  let body;
  try { body = await request.json(); } catch(e) { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const { key, status } = body;
  if(!key || !['approved', 'rejected', 'pending'].includes(status)){
    return NextResponse.json({ error: 'Missing key, or status must be approved/rejected/pending.' }, { status: 400 });
  }

  try {
    const s = store();
    const existing = await s.get(`blocklist:${key}`, { type: 'json' });
    if(!existing) return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
    existing.status = status;
    existing.reviewedAt = Date.now();
    await s.setJSON(`blocklist:${key}`, existing);
    return NextResponse.json({ ok: true, entry: existing });
  } catch (err) {
    return storeError(err);
  }
}

// DELETE ?key=... — permanently remove an entry (e.g. cleaning up old rejected ones)
export async function DELETE(request){
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if(!key) return NextResponse.json({ error: 'Missing key.' }, { status: 400 });

  try {
    const s = store();
    await s.delete(`blocklist:${key}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeError(err);
  }
}
