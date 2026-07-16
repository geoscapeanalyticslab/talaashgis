import { NextResponse } from 'next/server';
import { fetchBatch, parseYear } from '../../../lib/sources';
import { store } from '../../../lib/blobs';

export const dynamic = 'force-dynamic';

// POST, not GET: the continuation `state` object (in particular seenKeys,
// the running dedup list) grows every round of Pakistan-only scope's
// auto-expand loop. As a URL query param it could grow past the URL-length
// limit within a few rounds and get rejected before ever reaching this
// handler — silently returning a non-JSON error page instead of a real
// response. A JSON body has no such practical size limit.
export async function POST(request){
  let body;
  try { body = await request.json(); } catch(e) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const kw = (body.kw || '').trim();
  if(!kw){
    return NextResponse.json({ error: 'Missing "kw" (keyword) parameter.' }, { status: 400 });
  }

  const scope = body.scope === 'global' ? 'global' : 'pk';
  const anyYear = !!body.anyYear;
  const yrRaw = anyYear ? '' : (body.year || '').trim();
  let year = null;
  if(yrRaw){
    year = parseYear(yrRaw);
    if(!year){
      return NextResponse.json({ error: 'Year format: 2022, 2020-2024, 2015- (from), or -2010 (until).' }, { status: 400 });
    }
  }

  const filters = {
    openAccess: !!body.openAccess,
    minCite: parseInt(body.minCite || '0', 10) || 0,
    reputed: !!body.reputed,
    verifiedOnly: !!body.verifiedOnly
  };

  // Pagination/dedup continuation state from a previous "load more"/auto-expand
  // call, if any. Opaque to the client — it just stores whatever we returned
  // last time and sends it back unchanged.
  let state = (body.state && typeof body.state === 'object') ? body.state : null;
  if(!state || state.kw !== kw || state.year !== year || state.scope !== scope){
    state = {
      kw, displayKw: kw, year, scope,
      s2Offset: 0, crOffset: 0, oaPage: 1, arxivStart: 0, springerStart: 0,
      coreOffset: 0, elsevierStart: 0, ieeeStart: 0, nasaAdsStart: 0,
      s2HasMore: true, crHasMore: true, oaHasMore: true, arxivHasMore: true, springerHasMore: true,
      coreHasMore: true, elsevierHasMore: true, ieeeHasMore: true, nasaAdsHasMore: true,
      seenKeys: []
    };
  }

  let blobStore = null;
  try { blobStore = store(); } catch(e) { /* Netlify Blobs unavailable — search still works, blocklist just gets skipped */ }

  try {
    const papers = await fetchBatch(state, filters, blobStore);
    const hasMore = state.s2HasMore || state.crHasMore || state.oaHasMore || state.arxivHasMore ||
      state.springerHasMore || state.coreHasMore || state.elsevierHasMore || state.ieeeHasMore || state.nasaAdsHasMore;
    return NextResponse.json({ papers, state, hasMore });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'Search failed.' }, { status: 500 });
  }
}
