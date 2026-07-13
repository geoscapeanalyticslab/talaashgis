import { NextResponse } from 'next/server';
import { store } from '../../../lib/blobs';

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
    const { blobs } = await s.list({ prefix: `bookmarks:${syncCode}:` });
    const bookmarks = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
    bookmarks.sort((a, b) => (b.savedAtMs || 0) - (a.savedAtMs || 0));
    return NextResponse.json({ bookmarks });
  } catch (err) {
    return storeError(err);
  }
}

export async function POST(request){
  let body;
  try { body = await request.json(); } catch(e) { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const syncCode = requireSyncCode(body.syncCode);
  const paper = body.paper;
  if(!syncCode || !paper || !paper.key) return NextResponse.json({ error: 'Missing syncCode or paper.' }, { status: 400 });

  const record = {
    ...paper,
    collection: body.collection || 'General',
    note: paper.note || '',
    savedAtMs: Date.now(),
    savedAt: new Date().toLocaleDateString()
  };

  try {
    const s = store();
    await s.setJSON(`bookmarks:${syncCode}:${paper.key}`, record);
    return NextResponse.json({ ok: true, bookmark: record });
  } catch (err) {
    return storeError(err);
  }
}

export async function PATCH(request){
  let body;
  try { body = await request.json(); } catch(e) { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const syncCode = requireSyncCode(body.syncCode);
  if(!syncCode || !body.key) return NextResponse.json({ error: 'Missing syncCode or key.' }, { status: 400 });

  try {
    const s = store();
    const existing = await s.get(`bookmarks:${syncCode}:${body.key}`, { type: 'json' });
    if(!existing) return NextResponse.json({ error: 'Bookmark not found.' }, { status: 404 });

    const updated = { ...existing };
    if(typeof body.note === 'string') updated.note = body.note;
    if(typeof body.collection === 'string') updated.collection = body.collection;
    await s.setJSON(`bookmarks:${syncCode}:${body.key}`, updated);
    return NextResponse.json({ ok: true, bookmark: updated });
  } catch (err) {
    return storeError(err);
  }
}

export async function DELETE(request){
  const { searchParams } = new URL(request.url);
  const syncCode = requireSyncCode(searchParams.get('syncCode'));
  const key = searchParams.get('key');
  if(!syncCode || !key) return NextResponse.json({ error: 'Missing syncCode or key.' }, { status: 400 });

  try {
    const s = store();
    await s.delete(`bookmarks:${syncCode}:${key}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeError(err);
  }
}
