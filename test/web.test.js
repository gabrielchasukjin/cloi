import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerWebSearchTool, searchYoucom } from '../src/tools/web.js';

function makeRegistry() {
  const registry = new ToolRegistry();
  registerWebSearchTool(registry);
  return registry;
}

/** Responds with the given status and JSON body, capturing the request. */
function stubFetch({ status = 200, body = {}, url: bodyUrl } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (status === 'throw') throw new TypeError('fetch failed');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { impl, calls };
}

function withKey(key, fn) {
  const prev = process.env.YDC_API_KEY;
  if (key === null) delete process.env.YDC_API_KEY;
  else process.env.YDC_API_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.YDC_API_KEY;
    else process.env.YDC_API_KEY = prev;
  }
}

test('web_search is unavailable without YDC_API_KEY', async () => {
  await withKey(null, async () => {
    const registry = makeRegistry();
    const available = await registry.available();
    assert.equal(available.some((t) => t.name === 'web_search'), false);
    // Registered but not offered: the schema list stays as it was without it.
    const schemas = await registry.schemas();
    assert.equal(schemas.some((s) => s.function.name === 'web_search'), false);
  });
});

test('web_search is available with YDC_API_KEY', async () => {
  await withKey('test-key-123456', async () => {
    const registry = makeRegistry();
    const available = await registry.available();
    assert.equal(available.some((t) => t.name === 'web_search'), true);
  });
});

test('an empty exported key counts as no key', async () => {
  await withKey('   ', async () => {
    const registry = makeRegistry();
    const available = await registry.available();
    assert.equal(available.some((t) => t.name === 'web_search'), false);
  });
});

test('execute reports a helpful error when the key is missing at call time', async () => {
  const registry = makeRegistry();
  await withKey(null, async () => {
    const tool = registry.get('web_search');
    const result = await tool.execute({ query: 'x' }, {});
    assert.equal(result.isError, true);
    assert.match(result.output, /YDC_API_KEY/);
  });
});

test('searchYoucom sends the query and both auth headers', async () => {
  const { impl, calls } = stubFetch({ body: { results: [] } });
  await withKey('test-key-123456', () =>
    searchYoucom('ollama latest version', { key: 'test-key-123456', fetchImpl: impl }));

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.match(url, /^https:\/\/api\.you\.com\/api\/search\?/);
  assert.match(url, /q=ollama\+latest\+version/);
  assert.equal(init.headers['X-API-Key'], 'test-key-123456');
  assert.match(init.headers.Authorization, /^Bearer test-key-123456$/);
});

test('searchYoucom formats results as a numbered list', async () => {
  const { impl } = stubFetch({
    body: {
      results: [
        { title: 'Ollama', url: 'https://ollama.com', description: 'Run models locally.' },
        { title: 'Blog', url: 'https://example.com/post', description: 'A  '.repeat(400) },
      ],
    },
  });
  const result = await searchYoucom('ollama', { key: 'k', fetchImpl: impl });
  assert.equal(result.isError, undefined);
  assert.match(result.output, /^2 results for "ollama":/);
  assert.match(result.output, /1\. Ollama\n\s+https:\/\/ollama\.com/);
  // Long snippets are clipped, not dumped whole.
  assert.match(result.output, /…/);
  assert.ok(result.output.length < 2000);
});

test('searchYoucom tolerates alternate field names in the response', async () => {
  const { impl } = stubFetch({
    body: { results: [{ name: 'Docs', link: 'https://docs.example', snippet: 'snippet text' }] },
  });
  const result = await searchYoucom('q', { key: 'k', fetchImpl: impl });
  assert.match(result.output, /1\. Docs/);
  assert.match(result.output, /https:\/\/docs\.example/);
  assert.match(result.output, /snippet text/);
});

test('searchYoucom drops results without a URL', async () => {
  const { impl } = stubFetch({
    body: { results: [{ title: 'No URL' }, { title: 'Has one', url: 'https://x' }] },
  });
  const result = await searchYoucom('q', { key: 'k', fetchImpl: impl });
  assert.match(result.output, /^1 results/);
  assert.doesNotMatch(result.output, /No URL/);
});

test('searchYoucom reports "no results" as a normal outcome, not an error', async () => {
  const { impl } = stubFetch({ body: { results: [] } });
  const result = await searchYoucom('nothing matching', { key: 'k', fetchImpl: impl });
  assert.equal(result.isError, undefined);
  assert.match(result.output, /No results for "nothing matching"/);
});

test('searchYoucom surfaces auth failures with the key fix', async () => {
  const { impl } = stubFetch({ status: 401 });
  const result = await searchYoucom('q', { key: 'bad', fetchImpl: impl });
  assert.equal(result.isError, true);
  assert.match(result.output, /401/);
  assert.match(result.output, /YDC_API_KEY/);
});

test('searchYoucom reports other HTTP errors without the auth hint', async () => {
  const { impl } = stubFetch({ status: 500 });
  const result = await searchYoucom('q', { key: 'k', fetchImpl: impl });
  assert.equal(result.isError, true);
  assert.match(result.output, /500/);
  assert.doesNotMatch(result.output, /check YDC_API_KEY/);
});

test('searchYoucom reports network failures without throwing', async () => {
  const { impl } = stubFetch({ status: 'throw' });
  const result = await searchYoucom('q', { key: 'k', fetchImpl: impl });
  assert.equal(result.isError, true);
  assert.match(result.output, /web_search failed/);
});

test('dispatch of web_search never throws through the registry', async () => {
  await withKey(null, async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch('web_search', { query: 'x' }, {});
    assert.equal(result.isError, true);
    assert.match(result.output, /YDC_API_KEY/);
  });
});
