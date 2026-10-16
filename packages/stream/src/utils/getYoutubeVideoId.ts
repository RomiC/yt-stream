export function getYoutubeVideoId(value: string): string {
  const url = new URL(value);
  return url.pathname === '/watch' ? url.searchParams.get('v')! : url.pathname.replace(/\/$/, '').split('/').at(-1)!;
}
