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
    const list = (await s.get(`history:${syncCode}`, { type: 'json' })) || [];
    return NextResponse.json({ history: list });
  } catch (err) {
    return storeError(err);
  }
}

export async function POST(request){
  let body;
  try { body = await request.json(); } catch(e) { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const syncCode = requireSyncCode(body.syncCode);
  if(!syncCode || !body.entry) return NextResponse.json({ error: 'Missing syncCode or entry.' }, { status: 400 });

  try {
    const s = store();
    const list = (await s.get(`history:${syncCode}`, { type: 'json' })) || [];
    list.unshift(body.entry);
    const trimmed = list.slice(0, 40);
    await s.setJSON(`history:${syncCode}`, trimmed);
    return NextResponse.json({ ok: true, history: trimmed });
  } catch (err) {
    return storeError(err);
  }
}

export async function DELETE(request){
  const { searchParams } = new URL(request.url);
  const syncCode = requireSyncCode(searchParams.get('syncCode'));
  if(!syncCode) return NextResponse.json({ error: 'Missing or invalid syncCode.' }, { status: 400 });

  try {
    const s = store();
    await s.delete(`history:${syncCode}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeError(err);
  }
}
