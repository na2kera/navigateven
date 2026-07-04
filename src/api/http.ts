// A stalled connection (no response, no error) would otherwise leave callers
// waiting forever — e.g. the phone UI's search button disables itself while a
// request is in flight and only re-enables in `finally`. (issue #11-3)
export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
