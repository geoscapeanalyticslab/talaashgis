import { NextResponse } from 'next/server';
import { store } from '../../../lib/blobs';
import { maybeQueueForBlocklist } from '../../../lib/blocklist';

export const dynamic = 'force-dynamic';

function requireSyncCode(v){
  const code = (v || '').trim();
  return code.length >= 4 ? code : null;
}

function storeError(err){
  console.error('Blob store error:', err.message);
  const hint = /environment has not been configured/i.test(err.message)
    ? ' (Netlify Blobs isn\'t available — run via `netlify dev` locally, or deploy to Netlify.)'
    : '';
  return NextResponse.json({ error: 'Storage backend unavailable.' + hint }, { status: 503 });
}

export async function GET(request){
  const { searchParams } = new URL(request.url);
  const syncCode = requireSyncCode(searchParams.get('syncCode'));
  if(!syncCode) return NextResponse.json({ error: 'Missing or invalid syncCode.' }, { status: 400 });

  try {
    const s = store();
    const { blobs } = await s.list({ prefix: `reports:${syncCode}:` });
    const reports = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
    reports.sort((a, b) => (b.t || 0) - (a.t || 0));
    return NextResponse.json({ reports });
  } catch (err) {
    return storeError(err);
  }
}

export async function POST(request){
  let body;
  try { body = await request.json(); } catch(e) { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const syncCode = requireSyncCode(body.syncCode);
  if(!syncCode) return NextResponse.json({ error: 'Missing or invalid syncCode.' }, { status: 400 });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const report = {
    id,
    title: (body.title || '').slice(0, 500),
    doi: (body.doi || '').slice(0, 200),
    reason: (body.reason || 'Other').slice(0, 100),
    comment: (body.comment || '').slice(0, 2000),
    t: Date.now()
  };

  try {
    const s = store();
    await s.setJSON(`reports:${syncCode}:${id}`, report);
    await maybeQueueForBlocklist(s, { title: report.title, doi: report.doi, reason: report.reason });
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return storeError(err);
  }
}

export async function DELETE(request){
  const { searchParams } = new URL(request.url);
  const syncCode = requireSyncCode(searchParams.get('syncCode'));
  const id = searchParams.get('id');
  if(!syncCode || !id) return NextResponse.json({ error: 'Missing syncCode or id.' }, { status: 400 });

  try {
    const s = store();
    await s.delete(`reports:${syncCode}:${id}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeError(err);
  }
}
