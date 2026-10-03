/** Fixture builders shared by the test files. */

export function makeRecord(overrides = {}) {
  return {
    id: 1,
    startedAt: '2026-01-03T10:00:00.000Z',
    time: 120,
    method: 'GET',
    url: 'https://api.example.com/v1/users/42',
    resourceType: 'xhr',
    status: 200,
    statusText: 'OK',
    httpVersion: 'http/2.0',
    requestHeaders: [{ name: 'accept', value: 'application/json' }],
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    queryString: [],
    requestBody: null,
    responseMimeType: 'application/json',
    responseSize: 64,
    transferSize: 220,
    responseBody: '{"id":42}',
    responseEncoding: null,
    bodyPending: false,
    fromCache: false,
    timings: null,
    serverIP: '93.184.216.34',
    error: null,
    ...overrides,
  };
}

export function makeHarEntry(overrides = {}) {
  return {
    startedDateTime: '2026-01-03T10:00:00.000Z',
    time: 135.5,
    _resourceType: 'fetch',
    serverIPAddress: '10.0.0.1',
    request: {
      method: 'post',
      url: 'https://api.example.com/v1/orders?dry=1',
      headers: [
        { name: ':method', value: 'POST' },
        { name: 'content-type', value: 'application/json' },
        { name: 'authorization', value: 'Bearer secret-token' },
      ],
      queryString: [{ name: 'dry', value: '1' }],
      postData: { mimeType: 'application/json', text: '{"sku":"A1"}' },
    },
    response: {
      status: 201,
      statusText: 'Created',
      httpVersion: 'http/2.0',
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { size: 31, mimeType: 'application/json' },
      _transferSize: 410,
    },
    timings: { blocked: 1, dns: -1, connect: -1, send: 2, wait: 100, receive: 5, ssl: -1 },
    ...overrides,
  };
}
