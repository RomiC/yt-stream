function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Matches the decoded param name, so percent-encoding (`?k%65y=`) cannot smuggle the key into logs.
export function redactApiKey(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const path = url.slice(0, queryStart);
  const query = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => (safeDecode(pair.split('=', 1)[0]) === 'key' ? 'key=[REDACTED]' : pair))
    .join('&');

  return `${path}?${query}`;
}
