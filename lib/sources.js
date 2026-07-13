// Server-side search + accuracy logic for TalaashGIS.
// Ported 1:1 from the original client-side implementation so behavior doesn't
// silently drift between the two versions. Runs in a Next.js API route, so API
// keys (OPENALEX_API_KEY, etc.) stay in server environment variables and are
// never sent to the browser.

const { XMLParser } = require('fast-xml-parser');
const { getApprovedBlocklistKeys, blocklistKeyFor } = require('./blocklist');

const PAGE_S2 = 100;
const PAGE_CR = 50;
const PAGE_OA = 50;
const PAGE_ARXIV = 30;
const UNPAYWALL_CAP_PER_BATCH = 25;

const REPUTED_JOURNALS = [
  'remote sensing of environment', 'isprs journal of photogrammetry', 'international journal of remote sensing',
  'ieee transactions on geoscience and remote sensing', 'giscience & remote sensing', 'giscience and remote sensing',
  'photogrammetric engineering', 'international journal of applied earth observation', 'journal of applied remote sensing',
  'big earth data', 'geocarto international', 'international journal of digital earth', 'computers & geosciences',
  'computers and geosciences', 'remote sensing',
  'science of the total environment', 'environmental research letters', 'journal of environmental management',
  'ecological indicators', 'environmental monitoring and assessment', 'natural hazards', 'natural hazards and earth system sciences',
  'journal of hydrology', 'water resources research', 'atmospheric environment', 'environmental science and pollution research',
  'applied geography', 'progress in human geography', 'annals of the american association of geographers',
  'geographical journal', 'transactions of the institute of british geographers', 'urban studies', 'landscape and urban planning',
  'advances in space research', 'space weather', 'acta astronautica', 'journal of geophysical research',
  'earth and space science', 'planetary and space science'
];
function isReputed(venue){
  if(!venue) return false;
  const v = venue.toLowerCase();
  return REPUTED_JOURNALS.some(j => v.includes(j));
}

function keyFor(title){ return (title||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,80); }

const PAKISTAN_TERMS = [
  'pakistan','pakistani','punjab','sindh','balochistan','baluchistan','khyber pakhtunkhwa',
  'khyber-pakhtunkhwa',' kpk ','gilgit-baltistan','gilgit baltistan','azad kashmir','islamabad',
  'karachi','lahore','peshawar','quetta','multan','faisalabad','rawalpindi','hyderabad, sindh',
  'indus basin','indus river','indus delta'
];
function mentionsPakistan(text){
  if(!text) return false;
  const t = ' ' + text.toLowerCase() + ' ';
  return PAKISTAN_TERMS.some(term => t.includes(term));
}

// "Punjab" and "Balochistan/Baluchestan" are NOT unique to Pakistan (Indian Punjab;
// Iranian Sistan and Baluchestan) — see UNAMBIGUOUS/AMBIGUOUS split below.
const UNAMBIGUOUS_PK_TERMS = PAKISTAN_TERMS.filter(t => t !== 'punjab' && t !== 'balochistan' && t !== 'baluchistan');
const AMBIGUOUS_PK_TERMS = ['punjab', 'balochistan', 'baluchistan'];
const CONFLICTING_COUNTRY_TERMS = [
  'india','indian','bangladesh','bangladeshi','iran','iranian','afghanistan','afghan',
  'china','chinese','nepal','nepalese','sri lanka','myanmar','bhutan','turkey','turkish',
  'egypt','egyptian','morocco','moroccan','nigeria','nigerian','kenya','kenyan','indonesia',
  'indonesian','malaysia','malaysian','vietnam','vietnamese','thailand','thai'
];
function textHasAny(text, terms){
  if(!text) return false;
  const t = ' ' + text.toLowerCase() + ' ';
  return terms.some(term => t.includes(term));
}
// The paper's own content MUST show Pakistan as the study area — author
// institution affiliation alone is never enough, it only upgrades the badge
// once the content match already holds.
function pakistanConfidence(paper){
  const text = (paper.title||'') + ' ' + (paper.abstract||'') + ' ' + (paper.venue||'');
  const hasUnambiguous = textHasAny(text, UNAMBIGUOUS_PK_TERMS);
  const hasAmbiguousOnly = !hasUnambiguous && textHasAny(text, AMBIGUOUS_PK_TERMS);
  const hasConflict = textHasAny(text, CONFLICTING_COUNTRY_TERMS);
  const textSignal = hasUnambiguous || (hasAmbiguousOnly && !hasConflict);
  if(!textSignal) return null;
  return paper.verifiedPk ? 'verified' : 'keyword';
}

const STOPWORDS = new Set(['the','a','an','of','in','on','for','and','to','with','by','from','at','is','are','vs','using','based','via']);
const YEAR_TOKEN = /^(19|20)\d{2}$/;
function getTopicWords(rawKw){
  return (rawKw||'').toLowerCase().replace(/["']/g,'').split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !YEAR_TOKEN.test(w));
}
function matchesTopic(paper, rawKw){
  const words = getTopicWords(rawKw);
  if(words.length === 0) return true;
  const haystack = ((paper.title||'') + ' ' + (paper.abstract||'') + ' ' + (paper.venue||'')).toLowerCase();
  return words.every(w => haystack.includes(w));
}

function reconstructAbstract(invertedIndex){
  if(!invertedIndex) return null;
  const positions = [];
  for(const word in invertedIndex){
    invertedIndex[word].forEach(pos => { positions[pos] = word; });
  }
  return positions.join(' ').trim() || null;
}

const xmlParser = new XMLParser({ ignoreAttributes: false });
function parseArxivXml(xmlText){
  let doc;
  try { doc = xmlParser.parse(xmlText); } catch(e) { return []; }
  let entries = doc && doc.feed && doc.feed.entry;
  if(!entries) return [];
  if(!Array.isArray(entries)) entries = [entries];
  return entries.map(entry => {
    const title = (entry.title || '').toString().replace(/\s+/g, ' ').trim();
    const summary = (entry.summary || '').toString().replace(/\s+/g, ' ').trim();
    const published = (entry.published || '').toString();
    const year = published ? parseInt(published.slice(0,4), 10) : null;
    let authorsRaw = entry.author;
    if(!authorsRaw) authorsRaw = [];
    if(!Array.isArray(authorsRaw)) authorsRaw = [authorsRaw];
    const authors = authorsRaw.map(a => a && a.name).filter(Boolean).join(', ');
    const idUrl = (entry.id || '').toString();
    const doi = entry['arxiv:doi'] ? entry['arxiv:doi'].toString() : null;
    return {
      title, authors, year, venue: 'arXiv preprint', citations: 0, abstract: summary,
      url: idUrl, doi, openAccess: true, source: 'arXiv', verifiedPk: false
    };
  }).filter(p => p.title);
}

function buildUrls(kw, year, s2Offset, crOffset, oaPage, arxivStart, openAlexKey){
  const fields = 'title,authors,year,abstract,url,venue,citationCount,externalIds,isOpenAccess';
  let s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(kw)}&fields=${fields}&limit=${PAGE_S2}&offset=${s2Offset}`;
  if(year) s2Url += `&year=${year}`;

  let crUrl = `https://api.crossref.org/works?query=${encodeURIComponent(kw)}&rows=${PAGE_CR}&offset=${crOffset}&select=title,author,published,DOI,container-title,URL,abstract,is-referenced-by-count`;

  const oaSelect = 'id,title,authorships,publication_year,primary_location,cited_by_count,open_access,ids,abstract_inverted_index';
  let oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(kw)}&select=${oaSelect}&per-page=${PAGE_OA}&page=${oaPage}&mailto=talaashgis@app`;
  if(openAlexKey) oaUrl += `&api_key=${openAlexKey}`;

  let arxivQuery = `all:${kw}`;
  if(year){
    const parts = year.split('-');
    const fromY = parts[0] || '';
    const toY = parts[1] || parts[0];
    if(fromY) arxivQuery += ` AND submittedDate:[${fromY}01010000 TO ${toY}12312359]`;
  }
  const arxivUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(arxivQuery)}&start=${arxivStart}&max_results=${PAGE_ARXIV}`;

  if(year){
    const parts = year.split('-');
    const fromY = parts[0] || '';
    const toY = parts[1] || parts[0];
    if(fromY){
      crUrl += `&filter=from-pub-date:${fromY}-01-01,until-pub-date:${toY}-12-31`;
      oaUrl += `&filter=from_publication_date:${fromY}-01-01,to_publication_date:${toY}-12-31`;
    }
  }
  return { s2Url, crUrl, oaUrl, arxivUrl };
}

async function enrichUnpaywall(papers){
  const candidates = papers.filter(p => p.doi && !p.openAccess).slice(0, UNPAYWALL_CAP_PER_BATCH);
  if(candidates.length === 0) return papers;
  const results = await Promise.allSettled(candidates.map(p =>
    fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=talaashgis.app@gmail.com`).then(r => r.ok ? r.json() : null)
  ));
  results.forEach((res, i) => {
    if(res.status === 'fulfilled' && res.value && res.value.is_oa){
      candidates[i].openAccess = true;
      const loc = res.value.best_oa_location;
      if(loc && loc.url) candidates[i].oaUrl = loc.url;
    }
  });
  return papers;
}

// state: { kw, displayKw, year, scope, s2Offset, crOffset, oaPage, arxivStart,
//          s2HasMore, crHasMore, oaHasMore, arxivHasMore, seenKeys: string[] }
// filters: { openAccess, minCite, reputed, verifiedOnly }
// blobStore: a Netlify Blobs store instance (from lib/blobs.js store()), used to
// check the reviewer-approved blocklist. Passed in rather than created here so
// callers that don't have Blobs configured (e.g. local `next dev` without
// `netlify dev`) can catch that error themselves instead of every search failing.
async function fetchBatch(state, filters, blobStore){
  const openAlexKey = process.env.OPENALEX_API_KEY || '';
  const { s2Url, crUrl, oaUrl, arxivUrl } = buildUrls(
    state.kw, state.year, state.s2Offset, state.crOffset, state.oaPage, state.arxivStart, openAlexKey
  );

  const [s2res, crres, oares, arxivres] = await Promise.allSettled([
    state.s2HasMore ? fetch(s2Url) : Promise.resolve(null),
    state.crHasMore ? fetch(crUrl) : Promise.resolve(null),
    state.oaHasMore ? fetch(oaUrl) : Promise.resolve(null),
    state.arxivHasMore ? fetch(arxivUrl) : Promise.resolve(null)
  ]);

  let s2papers = [];
  if(s2res.status === 'fulfilled' && s2res.value && s2res.value.ok){
    const d = await s2res.value.json();
    const got = d.data || [];
    s2papers = got.map(p => ({
      title: p.title, authors: (p.authors||[]).map(a=>a.name).join(', '), year: p.year,
      venue: p.venue, citations: p.citationCount ?? 0, abstract: p.abstract, url: p.url,
      doi: p.externalIds && p.externalIds.DOI, openAccess: !!p.isOpenAccess, source: 'Semantic Scholar', verifiedPk: false
    }));
    state.s2Offset += got.length;
    state.s2HasMore = got.length === PAGE_S2 && (d.total ?? Infinity) > state.s2Offset;
  } else if(!(s2res.status === 'fulfilled' && s2res.value === null)){
    state.s2HasMore = false;
  }

  let crpapers = [];
  if(crres.status === 'fulfilled' && crres.value && crres.value.ok){
    const d = await crres.value.json();
    const items = (d.message && d.message.items) || [];
    crpapers = items.map(it => {
      const authors = (it.author||[]).map(a=>[a.given,a.family].filter(Boolean).join(' ')).join(', ');
      const yr = it.published && it.published['date-parts'] && it.published['date-parts'][0] && it.published['date-parts'][0][0];
      return {
        title: Array.isArray(it.title) ? it.title[0] : it.title, authors, year: yr,
        venue: Array.isArray(it['container-title']) ? it['container-title'][0] : it['container-title'],
        citations: it['is-referenced-by-count'] ?? 0,
        abstract: it.abstract ? it.abstract.replace(/<[^>]+>/g,'') : null,
        url: it.URL, doi: it.DOI, openAccess: false, source: 'CrossRef', verifiedPk: false
      };
    });
    state.crOffset += items.length;
    state.crHasMore = items.length === PAGE_CR;
  } else if(!(crres.status === 'fulfilled' && crres.value === null)){
    state.crHasMore = false;
  }

  let oapapers = [];
  if(oares.status === 'fulfilled' && oares.value && oares.value.ok){
    const d = await oares.value.json();
    const items = d.results || [];
    oapapers = items.map(it => {
      const authors = (it.authorships||[]).map(a => a.author && a.author.display_name).filter(Boolean).join(', ');
      const verifiedPk = (it.authorships||[]).some(a => (a.institutions||[]).some(inst => inst.country_code === 'PK'));
      const doi = it.ids && it.ids.doi ? it.ids.doi.replace('https://doi.org/','') : null;
      return {
        title: it.title, authors, year: it.publication_year,
        venue: it.primary_location && it.primary_location.source && it.primary_location.source.display_name,
        citations: it.cited_by_count ?? 0,
        abstract: reconstructAbstract(it.abstract_inverted_index),
        url: it.primary_location && it.primary_location.landing_page_url,
        doi, openAccess: !!(it.open_access && it.open_access.is_oa), source: 'OpenAlex', verifiedPk
      };
    });
    state.oaPage += 1;
    state.oaHasMore = items.length === PAGE_OA;
  } else if(!(oares.status === 'fulfilled' && oares.value === null)){
    state.oaHasMore = false;
  }

  let arxivpapers = [];
  if(arxivres.status === 'fulfilled' && arxivres.value && arxivres.value.ok){
    const text = await arxivres.value.text();
    arxivpapers = parseArxivXml(text);
    state.arxivStart += arxivpapers.length;
    state.arxivHasMore = arxivpapers.length === PAGE_ARXIV;
  } else if(!(arxivres.status === 'fulfilled' && arxivres.value === null)){
    state.arxivHasMore = false;
  }

  const seenKeys = new Set(state.seenKeys || []);
  let papers = [];
  [...oapapers, ...s2papers, ...crpapers, ...arxivpapers].forEach(p => {
    if(!p.title) return;
    const doiKey = p.doi ? ('doi:' + p.doi.toLowerCase().trim()) : null;
    const titleKey = keyFor(p.title);
    const dedupKey = doiKey || ('title:' + titleKey);
    if(seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
    p.key = titleKey;
    papers.push(p);
  });
  state.seenKeys = Array.from(seenKeys);

  // Reviewer-approved blocklist: papers that were confirmed irrelevant/off-topic/
  // duplicate via the report system are excluded from every future search, for
  // everyone — this is the "app learns from reports" mechanism, but gated on a
  // human approving it first, not applied automatically from a raw report.
  if(blobStore){
    try {
      const approvedKeys = await getApprovedBlocklistKeys(blobStore);
      if(approvedKeys.size > 0){
        papers = papers.filter(p => !approvedKeys.has(blocklistKeyFor(p.title, p.doi)));
      }
    } catch (e) {
      // If the blocklist can't be read for some reason, fail open rather than
      // breaking search entirely — better to show a possibly-imperfect result
      // than no results at all.
    }
  }

  papers = papers.filter(p => matchesTopic(p, state.displayKw));

  if(state.scope === 'pk'){
    papers = papers.filter(p => {
      const confidence = pakistanConfidence(p);
      if(!confidence) return false;
      p.pkConfidence = confidence;
      return true;
    });
  }

  papers = await enrichUnpaywall(papers);

  if(filters.openAccess) papers = papers.filter(p => p.openAccess);
  if(filters.minCite && filters.minCite > 0) papers = papers.filter(p => (p.citations||0) >= filters.minCite);
  if(filters.reputed) papers = papers.filter(p => isReputed(p.venue));
  if(state.scope === 'pk' && filters.verifiedOnly) papers = papers.filter(p => p.pkConfidence === 'verified');

  return papers;
}

function parseYear(raw){
  raw = (raw||'').trim();
  if(!raw) return null;
  const thisYear = new Date().getFullYear();
  if(/^\d{4}$/.test(raw)) return raw;
  if(/^\d{4}-\d{4}$/.test(raw)) return raw;
  if(/^\d{4}-$/.test(raw)) return raw.slice(0,4) + '-' + thisYear;
  if(/^-\d{4}$/.test(raw)) return '1900-' + raw.slice(1);
  return null;
}

module.exports = {
  fetchBatch, parseYear, mentionsPakistan, keyFor, isReputed,
  PAGE_S2, PAGE_CR, PAGE_OA, PAGE_ARXIV
};
