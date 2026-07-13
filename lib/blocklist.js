// Auto-blocklist: when a per-paper report is filed with a relevance-related
// reason, that paper is immediately excluded from every future search for
// everyone. The About tab still shows everything that's been auto-blocked,
// with an "Un-block" action in case a report was wrong — so mistakes are
// recoverable without needing to approve every single report by hand first.

const BLOCKLIST_TRIGGER_REASONS = new Set(['Not relevant to Pakistan', 'Off-topic', 'Duplicate']);

function blocklistKeyFor(title, doi){
  if(doi) return 'doi:' + doi.toLowerCase().trim();
  const titleKey = (title||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,80);
  return 'title:' + titleKey;
}

// Called from the reports route after a per-paper report is saved. No-op if
// the reason isn't a relevance-type reason, or if there's no paper title.
async function maybeQueueForBlocklist(store, { title, doi, reason }){
  if(!BLOCKLIST_TRIGGER_REASONS.has(reason) || !title) return;

  const key = blocklistKeyFor(title, doi);
  const blobKey = `blocklist:${key}`;
  const existing = await store.get(blobKey, { type: 'json' });

  const entry = existing || {
    key, title, doi: doi || '', status: 'approved', reportCount: 0,
    reasons: [], firstReportedAt: Date.now()
  };
  entry.reportCount += 1;
  entry.lastReportedAt = Date.now();
  if(!entry.reasons.includes(reason)) entry.reasons.push(reason);
  // If someone previously un-blocked this (status 'rejected'), a fresh report
  // re-activates it — repeated reports on the same paper should count for something.
  if(existing && existing.status === 'rejected') entry.status = 'approved';
  await store.setJSON(blobKey, entry);
}

// Called from the search route to get the set of DOI/title keys to exclude.
// Anything not explicitly un-blocked (status !== 'rejected') is excluded.
async function getApprovedBlocklistKeys(store){
  const { blobs } = await store.list({ prefix: 'blocklist:' });
  const entries = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  return new Set(entries.filter(e => e && e.status === 'approved').map(e => e.key));
}

module.exports = { blocklistKeyFor, maybeQueueForBlocklist, getApprovedBlocklistKeys, BLOCKLIST_TRIGGER_REASONS };
