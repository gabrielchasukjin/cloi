/**
 * Optional web search, through the You.com Search API.
 *
 * Cloi is local-first: everything runs on the host, and the README says so.
 * But a coding agent occasionally needs facts no file in the workspace holds —
 * a library's current major version, a deprecation notice, an error string
 * someone else has already hit. This tool covers that one case, and only when
 * the user has asked for it by exporting YDC_API_KEY. Without the key the
 * check() probe fails and the tool is never offered, so a default install
 * behaves exactly as before.
 *
 * The key is read from the environment here, in-process, and never passed to
 * a child or echoed in a result — `YDC_API_KEY` is also on the redaction list,
 * so a value that reaches output by some other route is still masked.
 */

/** Hard cap on one request. Search results age fast; ten is already a lot to read. */
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

/** A search is a lookup, not a research session. */
const TIMEOUT_MS = 15_000;

const ENDPOINT = 'https://api.you.com/api/search';

export function registerWebSearchTool(registry) {
  registry.register({
    name: 'web_search',
    description:
      'Search the live web via the You.com API and return the top results (title, URL, '
      + 'snippet). Use it only for facts that cannot come from the workspace: current '
      + 'library versions, release notes, deprecations, error reports. '
      + 'Everything else — code, files, tests — is already on this machine.',
    // The query leaves the host, so the first call asks — the same approval
    // that gates a shell command, with the same "always for this tool" answer
    // for the rest of the session.
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'integer', description: `Results to return, 1-${MAX_RESULTS} (default ${DEFAULT_RESULTS}).` },
      },
      required: ['query'],
    },
    // No key, no tool: the model is never shown a schema it cannot use, which
    // is the same reason the python tool disappears without an interpreter.
    check: () => hasApiKey(),

    async execute(args, ctx) {
      const key = apiKey();
      if (!key) {
        return { output: 'web_search is not configured. Export YDC_API_KEY to enable it.', isError: true };
      }

      const count = Math.min(Math.max(args.max_results || DEFAULT_RESULTS, 1), MAX_RESULTS);
      return searchYoucom(args.query, {
        key,
        numResults: count,
        signal: ctx?.signal,
      });
    },
  });
}

/** The key, trimmed; an exported empty string is no key at all. */
function apiKey() {
  return (process.env.YDC_API_KEY || '').trim() || null;
}

function hasApiKey() {
  return apiKey() !== null;
}

/**
 * One request against the You.com Search API.
 *
 * Exported for tests, which pass a stubbed `fetchImpl` rather than the network.
 * Resolves rather than rejects on every failure path so the registry's
 * dispatch never throws and the turn survives a failed lookup.
 *
 * @param {string} query
 * @param {{key: string, numResults?: number, signal?: AbortSignal, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{output: string, isError?: boolean}>}
 */
export async function searchYoucom(query, { key, numResults = DEFAULT_RESULTS, signal, fetchImpl = fetch } = {}) {
  const url = `${ENDPOINT}?${new URLSearchParams({ q: query, numResults: String(numResults) })}`;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'X-API-Key': key,
        Authorization: `Bearer ${key}`,
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timed out after ${TIMEOUT_MS / 1000}s`
      : err?.message;
    return { output: `web_search failed: ${reason}`, isError: true };
  }

  if (!res.ok) {
    // 401/403 means the key, which is the one error the user can fix from here.
    const hint = res.status === 401 || res.status === 403
      ? ' — check YDC_API_KEY at https://you.com/platform/api-keys'
      : '';
    return { output: `web_search failed: You.com API returned ${res.status}${hint}.`, isError: true };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { output: 'web_search failed: You.com API returned a non-JSON body.', isError: true };
  }

  const hits = extractHits(body);
  if (!hits.length) return { output: `No results for "${query}".` };

  const lines = hits.map((hit, i) => {
    const title = hit.title || '(untitled)';
    const snippet = (hit.description || '').replace(/\s+/g, ' ').trim();
    const shown = snippet.length > 280 ? `${snippet.slice(0, 280)}…` : snippet;
    return shown
      ? `${i + 1}. ${title}\n   ${hit.url}\n   ${shown}`
      : `${i + 1}. ${title}\n   ${hit.url}`;
  });

  return { output: `${hits.length} results for "${query}":\n${lines.join('\n')}` };
}

/**
 * Pull a flat list of hits out of the response.
 *
 * The documented shape is `results: [{ title, url, description }]`, but field
 * names have drifted over the life of the API, so each is read with a fallback
 * rather than trusted.
 */
function extractHits(body) {
  const list = Array.isArray(body?.results) ? body.results : [];
  return list
    .map((hit) => ({
      title: hit?.title || hit?.name || '',
      url: hit?.url || hit?.link || '',
      description: hit?.description || hit?.snippet || '',
    }))
    .filter((hit) => hit.url);
}
