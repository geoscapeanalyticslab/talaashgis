// Server-side search + accuracy logic for GRIPS.
// Runs in a Next.js API route, so API keys stay in server environment
// variables and are never sent to the browser.

const { XMLParser } = require('fast-xml-parser');
const { getApprovedBlocklistKeys, blocklistKeyFor } = require('./blocklist');

const PAGE_S2 = 100;
const PAGE_CR = 50;
const PAGE_OA = 50;
const PAGE_ARXIV = 30;
const PAGE_SPRINGER = 20;
const PAGE_CORE = 20;
const PAGE_ELSEVIER = 20;
const PAGE_IEEE = 25;
const PAGE_NASA_ADS = 20;
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
  'indonesian','malaysia','malaysian','vietnam','vietnamese','thailand','thai',
  // Papers about the Indian side of Punjab or the Iranian side of Balochistan
  // (Sistan and Baluchestan province) very often name a district/city instead
  // of the country itself, so the country-name check above misses them. These
  // catch that case so an ambiguous "Punjab"/"Balochistan" mention doesn't
  // wrongly pass as Pakistan just because "India"/"Iran" wasn't spelled out.
  'ludhiana','amritsar','patiala','jalandhar','chandigarh','bathinda','moga','sangrur',
  'ferozepur','hoshiarpur','gurdaspur','faridkot','punjab, india','indian punjab',
  'zahedan','chabahar','iranshahr','sistan','saravan','khash','sistan and baluchestan',
  'sistan-baluchestan','iranian balochistan'
];
function textHasAny(text, terms){
  if(!text) return false;
  const t = ' ' + text.toLowerCase() + ' ';
  return terms.some(term => t.includes(term));
}
// The paper's own content MUST show Pakistan as the study area — author
// institution affiliation alone is never enough, it only upgrades the badge
// once the content match already holds.
//
// A mention of a Pakistan term anywhere in title+abstract+venue is NOT by
// itself proof that Pakistan is the paper's actual study area: regional/
// comparative papers ("drought monitoring across India, Pakistan and
// Bangladesh", "Indus and Ganges basin water security") routinely name
// Pakistan alongside other countries while their real focus is elsewhere.
// So:
//  - If the TITLE names Pakistan, trust it (authors title papers after their
//    actual study area, even in comparative studies) regardless of what else
//    the abstract mentions.
//  - If Pakistan is only named in the abstract/venue (not the title), require
//    that NO conflicting country is mentioned anywhere — a bare abstract
//    mention alongside other countries is usually the regional-study case,
//    not a Pakistan-focused one.
function pakistanConfidence(paper){
  const title = paper.title || "";
  const fullText = title + " " + (paper.abstract || "") + " " + (paper.venue || "");

  // Keep ANY paper that uses the name Pakistan (or an unambiguously Pakistani
  // place: Lahore, Karachi, Islamabad, Sindh, Indus Basin, Peshawar, Quetta...)
  // ANYWHERE in title/abstract/venue — EVEN IF it also names India or another
  // country. If Pakistan is named, extract it.
  if(textHasAny(title, UNAMBIGUOUS_PK_TERMS)){
    return paper.verifiedPk ? "verified" : "keyword";
  }
  if(textHasAny(fullText, UNAMBIGUOUS_PK_TERMS)){
    return paper.verifiedPk ? "verified" : "keyword";
  }

  // The name Pakistan is not used anywhere (a bare "Punjab"/"Balochistan" alone
  // does NOT count — those are shared with India/Iran) → reject.
  return null;
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

// Splits a "2020", "2020-2024", "2015-", "-2010" year string into [from, to].
function yearRange(year){
  const parts = year.split('-');
  const fromY = parts[0] || '';
  const toY = parts[1] || parts[0];
  return [fromY, toY];
}

// Builds { name: { url, headers? } } for every source that should be queried
// this round. A source is omitted entirely if it has no key configured (for
// key-gated sources) or if its own hasMore flag says it's exhausted.
function buildRequests(state){
  const { kw, year } = state;
  // In Pakistan scope, add "Pakistan" to the free-text query itself.
  const kwq = state.scope === 'pk' ? `${kw} Pakistan` : kw;
  const reqs = {};

  if(state.s2HasMore){
    const fields = 'title,authors,year,abstract,url,venue,citationCount,externalIds,isOpenAccess';
    let url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(kwq)}&fields=${fields}&limit=${PAGE_S2}&offset=${state.s2Offset}`;
    if(year) url += `&year=${year}`;
    reqs.s2 = { url };
  }

  if(state.crHasMore){
    let url = `https://api.crossref.org/works?query=${encodeURIComponent(kwq)}&rows=${PAGE_CR}&offset=${state.crOffset}&select=title,author,published,DOI,container-title,URL,abstract,is-referenced-by-count`;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) url += `&filter=from-pub-date:${fromY}-01-01,until-pub-date:${toY}-12-31`;
    }
    reqs.cr = { url };
  }

  if(state.oaHasMore){
    const oaSelect = 'id,title,authorships,publication_year,primary_location,cited_by_count,open_access,ids,abstract_inverted_index';
    let url = `https://api.openalex.org/works?search=${encodeURIComponent(kwq)}&select=${oaSelect}&per-page=${PAGE_OA}&page=${state.oaPage}&mailto=talaashgis@app`;
    if(process.env.OPENALEX_API_KEY) url += `&api_key=${process.env.OPENALEX_API_KEY}`;
    const oaFilters = [];
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) oaFilters.push(`from_publication_date:${fromY}-01-01`, `to_publication_date:${toY}-12-31`);
    }
    // (OpenAlex is searched by keyword + Pakistan like the other sources; the
    // name-based filter below keeps only papers that name Pakistan, so
    // foreign-authored papers about Pakistan are included too.)
    if(oaFilters.length) url += `&filter=${oaFilters.join(',')}`;
    reqs.oa = { url };
  }

  if(state.arxivHasMore){
    let q = `all:${kwq}`;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) q += ` AND submittedDate:[${fromY}01010000 TO ${toY}12312359]`;
    }
    reqs.arxiv = { url: `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&start=${state.arxivStart}&max_results=${PAGE_ARXIV}` };
  }

  const springerKey = process.env.SPRINGER_API_KEY;
  if(springerKey && state.springerHasMore !== false){
    let q = kw;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) q += ` onlinedatefrom:${fromY}-01-01 onlinedateto:${toY}-12-31`;
    }
    reqs.springer = { url: `https://api.springernature.com/meta/v2/json?q=${encodeURIComponent(q)}&api_key=${springerKey}&p=${PAGE_SPRINGER}&s=${(state.springerStart||0)+1}` };
  } else if(!springerKey){
    state.springerHasMore = false;
  }

  // CORE v3 — Authorization: Bearer header, not a query param.
  const coreKey = process.env.CORE_API_KEY;
  if(coreKey && state.coreHasMore !== false){
    let q = kw;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) q += ` AND yearPublished>=${fromY} AND yearPublished<=${toY}`;
    }
    reqs.core = {
      url: `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(q)}&limit=${PAGE_CORE}&offset=${state.coreOffset||0}`,
      headers: { Authorization: `Bearer ${coreKey}` }
    };
  } else if(!coreKey){
    state.coreHasMore = false;
  }

  // Elsevier ScienceDirect Search API — X-ELS-APIKey header.
  const elsevierKey = process.env.ELSEVIER_API_KEY;
  if(elsevierKey && state.elsevierHasMore !== false){
    let url = `https://api.elsevier.com/content/search/sciencedirect?query=${encodeURIComponent(kw)}&count=${PAGE_ELSEVIER}&start=${state.elsevierStart||0}`;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) url += `&date=${fromY}-${toY}`;
    }
    reqs.elsevier = { url, headers: { 'X-ELS-APIKey': elsevierKey, Accept: 'application/json' } };
  } else if(!elsevierKey){
    state.elsevierHasMore = false;
  }

  // IEEE Xplore Metadata API — apikey as a query param; 1-indexed start_record.
  const ieeeKey = process.env.IEEE_Xplore_API_KEY;
  if(ieeeKey && state.ieeeHasMore !== false){
    let url = `https://ieeexploreapi.ieee.org/api/v1/search/articles?apikey=${ieeeKey}&querytext=${encodeURIComponent(kw)}&max_records=${PAGE_IEEE}&start_record=${(state.ieeeStart||0)+1}`;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) url += `&start_year=${fromY}&end_year=${toY}`;
    }
    reqs.ieee = { url };
  } else if(!ieeeKey){
    state.ieeeHasMore = false;
  }

  // NASA ADS — Authorization: Bearer header. Especially useful for the "space
  // science" part of the app's scope (astronomy/astrophysics/planetary science).
  const nasaAdsKey = process.env.NASA_ADS_API_KEY;
  if(nasaAdsKey && state.nasaAdsHasMore !== false){
    let q = kw;
    if(year){
      const [fromY, toY] = yearRange(year);
      if(fromY) q += ` year:${fromY}-${toY}`;
    }
    const fl = 'title,author,year,abstract,doi,bibcode,citation_count,pub';
    reqs.nasaAds = {
      url: `https://api.adsabs.harvard.edu/v1/search/query?q=${encodeURIComponent(q)}&fl=${fl}&rows=${PAGE_NASA_ADS}&start=${state.nasaAdsStart||0}`,
      headers: { Authorization: `Bearer ${nasaAdsKey}` }
    };
  } else if(!nasaAdsKey){
    state.nasaAdsHasMore = false;
  }

  return reqs;
}

async function enrichUnpaywall(papers){
  const candidates = papers.filter(p => p.doi && !p.openAccess).slice(0, UNPAYWALL_CAP_PER_BATCH);
  if(candidates.length === 0) return papers;
  const results = await Promise.allSettled(candidates.map(p =>
    fetchWithTimeout(`https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=talaashgis.app@gmail.com`, undefined, UNPAYWALL_TIMEOUT_MS).then(r => r.ok ? r.json() : null)
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

// state carries kw/displayKw/year/scope plus, per source, an offset/page/start
// field and a *HasMore boolean; seenKeys is the running dedup set (array form,
// since it round-trips through JSON between requests).
// filters: { openAccess, minCite, reputed, verifiedOnly }
// blobStore: a Netlify Blobs store instance, used to check the reviewer-approved
// blocklist. Passed in rather than created here so callers without Blobs
// configured can handle that themselves.
// A single slow or hanging source (most likely one of the newer key-gated
// ones — CORE/Elsevier/IEEE/NASA ADS) must never be allowed to drag the whole
// batch, and therefore the whole Netlify function invocation, past its time
// limit (10s by default on Netlify). Every external fetch gets its own hard
// timeout; a source that misses it is treated as "no response this round"
// rather than blocking everything else. Unpaywall enrichment runs AFTER the
// main batch and is a nice-to-have, so it gets a shorter budget to leave room
// within the overall function time limit.
const SOURCE_TIMEOUT_MS = 5500;
const UNPAYWALL_TIMEOUT_MS = 3000;
function fetchWithTimeout(url, options, timeoutMs = SOURCE_TIMEOUT_MS){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchBatch(state, filters, blobStore){
  const reqs = buildRequests(state);
  const names = Object.keys(reqs);
  const settled = await Promise.allSettled(names.map(name => {
    const r = reqs[name];
    return fetchWithTimeout(r.url, r.headers ? { headers: r.headers } : undefined);
  }));
  const res = {};
  names.forEach((name, i) => { res[name] = settled[i]; });

  const ok = name => res[name] && res[name].status === 'fulfilled' && res[name].value && res[name].value.ok;
  const attempted = name => name in res;

  let s2papers = [];
  if(ok('s2')){
    const d = await res.s2.value.json();
    const got = d.data || [];
    s2papers = got.map(p => ({
      title: p.title, authors: (p.authors||[]).map(a=>a.name).join(', '), year: p.year,
      venue: p.venue, citations: p.citationCount ?? 0, abstract: p.abstract, url: p.url,
      doi: p.externalIds && p.externalIds.DOI, openAccess: !!p.isOpenAccess, source: 'Semantic Scholar', verifiedPk: false
    }));
    state.s2Offset += got.length;
    state.s2HasMore = got.length === PAGE_S2 && (d.total ?? Infinity) > state.s2Offset;
  } else if(attempted('s2')){
    state.s2HasMore = false;
  }

  let crpapers = [];
  if(ok('cr')){
    const d = await res.cr.value.json();
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
  } else if(attempted('cr')){
    state.crHasMore = false;
  }

  let oapapers = [];
  if(ok('oa')){
    const d = await res.oa.value.json();
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
  } else if(attempted('oa')){
    state.oaHasMore = false;
  }

  let arxivpapers = [];
  if(ok('arxiv')){
    const text = await res.arxiv.value.text();
    arxivpapers = parseArxivXml(text);
    state.arxivStart += arxivpapers.length;
    state.arxivHasMore = arxivpapers.length === PAGE_ARXIV;
  } else if(attempted('arxiv')){
    state.arxivHasMore = false;
  }

  let springerpapers = [];
  if(ok('springer')){
    const d = await res.springer.value.json();
    const items = d.records || [];
    springerpapers = items.map(it => {
      const authors = (it.creators || []).map(c => c.creator).filter(Boolean).join(', ');
      const year = it.publicationDate ? parseInt(String(it.publicationDate).slice(0,4), 10) : null;
      const urlObj = Array.isArray(it.url) ? it.url[0] : null;
      return {
        title: it.title, authors, year,
        venue: it.publicationName || it.journalTitle || null,
        citations: 0,
        abstract: it.abstract || null,
        url: (urlObj && urlObj.value) || (it.doi ? `https://doi.org/${it.doi}` : null),
        doi: it.doi || null,
        openAccess: it.openaccess === 'true' || it.openaccess === true,
        source: 'Springer Nature', verifiedPk: false
      };
    }).filter(p => p.title);
    state.springerStart = (state.springerStart || 0) + items.length;
    state.springerHasMore = items.length === PAGE_SPRINGER;
  } else if(attempted('springer')){
    state.springerHasMore = false;
  }

  let corepapers = [];
  if(ok('core')){
    const d = await res.core.value.json();
    const items = d.results || [];
    corepapers = items.map(it => {
      const authors = (it.authors || []).map(a => a.name).filter(Boolean).join(', ');
      const venue = it.publisher || (it.journals && it.journals[0] && it.journals[0].title) || null;
      return {
        title: it.title, authors, year: it.yearPublished || null,
        venue, citations: it.citationCount || 0,
        abstract: it.abstract || null,
        url: it.downloadUrl || (it.doi ? `https://doi.org/${it.doi}` : null),
        doi: it.doi || null,
        openAccess: true,
        source: 'CORE', verifiedPk: false
      };
    }).filter(p => p.title);
    state.coreOffset = (state.coreOffset || 0) + items.length;
    state.coreHasMore = items.length === PAGE_CORE;
  } else if(attempted('core')){
    state.coreHasMore = false;
  }

  let elsevierpapers = [];
  if(ok('elsevier')){
    const d = await res.elsevier.value.json();
    const sr = d['search-results'] || {};
    const items = sr.entry || [];
    elsevierpapers = items.map(it => {
      const links = Array.isArray(it.link) ? it.link : [];
      const selfLink = links.find(l => l['@ref'] === 'scidir') || links.find(l => l['@ref'] === 'self') || links[0];
      let authors = '';
      if(it.authors && Array.isArray(it.authors.author)){
        authors = it.authors.author.map(a => [a['given-name'], a.surname].filter(Boolean).join(' ')).join(', ');
      } else if(it['dc:creator']){
        authors = it['dc:creator'];
      }
      const doi = it['prism:doi'] || null;
      const year = it['prism:coverDate'] ? parseInt(String(it['prism:coverDate']).slice(0,4), 10) : null;
      return {
        title: it['dc:title'], authors, year,
        venue: it['prism:publicationName'] || null,
        citations: 0,
        abstract: it['dc:description'] || null,
        url: (selfLink && selfLink['@href']) || (doi ? `https://doi.org/${doi}` : null),
        doi, openAccess: false,
        source: 'ScienceDirect', verifiedPk: false
      };
    }).filter(p => p.title);
    const totalResults = parseInt(sr['opensearch:totalResults'], 10) || 0;
    state.elsevierStart = (state.elsevierStart || 0) + items.length;
    state.elsevierHasMore = items.length === PAGE_ELSEVIER && state.elsevierStart < totalResults;
  } else if(attempted('elsevier')){
    state.elsevierHasMore = false;
  }

  let ieeepapers = [];
  if(ok('ieee')){
    const d = await res.ieee.value.json();
    const items = d.articles || [];
    ieeepapers = items.map(it => {
      const authors = (it.authors && Array.isArray(it.authors.authors))
        ? it.authors.authors.map(a => a.full_name).filter(Boolean).join(', ') : '';
      return {
        title: it.title, authors, year: it.publication_year ? parseInt(it.publication_year, 10) : null,
        venue: it.publication_title || null,
        citations: it.citing_paper_count || 0,
        abstract: it.abstract || null,
        url: it.html_url || it.pdf_url || (it.doi ? `https://doi.org/${it.doi}` : null),
        doi: it.doi || null,
        openAccess: !!it.access_type && /open/i.test(it.access_type),
        source: 'IEEE Xplore', verifiedPk: false
      };
    }).filter(p => p.title);
    state.ieeeStart = (state.ieeeStart || 0) + items.length;
    state.ieeeHasMore = items.length === PAGE_IEEE;
  } else if(attempted('ieee')){
    state.ieeeHasMore = false;
  }

  let nasaAdsPapers = [];
  if(ok('nasaAds')){
    const d = await res.nasaAds.value.json();
    const items = (d.response && d.response.docs) || [];
    nasaAdsPapers = items.map(it => {
      const title = Array.isArray(it.title) ? it.title[0] : it.title;
      const doi = Array.isArray(it.doi) ? it.doi[0] : it.doi;
      return {
        title, authors: (it.author || []).join(', '), year: it.year ? parseInt(it.year, 10) : null,
        venue: it.pub || null,
        citations: it.citation_count || 0,
        abstract: it.abstract || null,
        url: doi ? `https://doi.org/${doi}` : (it.bibcode ? `https://ui.adsabs.harvard.edu/abs/${it.bibcode}` : null),
        doi: doi || null,
        openAccess: false,
        source: 'NASA ADS', verifiedPk: false
      };
    }).filter(p => p.title);
    const numFound = (d.response && d.response.numFound) || 0;
    state.nasaAdsStart = (state.nasaAdsStart || 0) + items.length;
    state.nasaAdsHasMore = items.length === PAGE_NASA_ADS && state.nasaAdsStart < numFound;
  } else if(attempted('nasaAds')){
    state.nasaAdsHasMore = false;
  }

  const seenKeys = new Set(state.seenKeys || []);
  let papers = [];
  [...oapapers, ...s2papers, ...crpapers, ...arxivpapers, ...springerpapers, ...corepapers, ...elsevierpapers, ...ieeepapers, ...nasaAdsPapers].forEach(p => {
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

  if(blobStore){
    try {
      const approvedKeys = await getApprovedBlocklistKeys(blobStore);
      if(approvedKeys.size > 0){
        papers = papers.filter(p => !approvedKeys.has(blocklistKeyFor(p.title, p.doi)));
      }
    } catch (e) {
      // Fail open — better to show a possibly-imperfect result than none at all.
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
