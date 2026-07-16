import { NextResponse } from 'next/server';
import { fetchBatch, parseYear } from '../../../lib/sources';
import { store } from '../../../lib/blobs';

export const dynamic = 'force-dynamic';

export async function GET(request){
  const { searchParams } = new URL(request.url);
  const kw = (searchParams.get('kw') || '').trim();
  if(!kw){
    return NextResponse.json({ error: 'Missing "kw" (keyword) parameter.' }, { status: 400 });
  }

  const scope = searchParams.get('scope') === 'global' ? 'global' : 'pk';
  const anyYear = searchParams.get('anyYear') === '1';
  const yrRaw = anyYear ? '' : (searchParams.get('year') || '').trim();
  let year = null;
  if(yrRaw){
    year = parseYear(yrRaw);
    if(!year){
      return NextResponse.json({ error: 'Year format: 2022, 2020-2024, 2015- (from), or -2010 (until).' }, { status: 400 });
    }
  }

  const filters = {
    openAccess: searchParams.get('openAccess') === '1',
    minCite: parseInt(searchParams.get('minCite') || '0', 10) || 0,
    reputed: searchParams.get('reputed') === '1',
    verifiedOnly: searchParams.get('verifiedOnly') === '1'
  };

  // Pagination/dedup continuation state from a previous "load more" call, if any.
  // Opaque to the client — it just stores whatever we returned last time and
  // sends it back unchanged.
  let state;
  const stateParam = searchParams.get('state');
  if(stateParam){
    try { state = JSON.parse(stateParam); } catch(e) { state = null; }
  }
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
