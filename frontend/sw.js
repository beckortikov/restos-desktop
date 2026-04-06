const CACHE_NAME = 'restos-v3'

const PRECACHE_URLS = [
  '/', '/login', '/dashboard',
  '/operations/pos', '/operations/table-map', '/operations/kitchen',
  '/operations/orders', '/operations/batch-cooking', '/operations/shifts',
  '/operations/showcase',
  '/warehouse/inventory', '/warehouse/menu', '/warehouse/receipts',
  '/warehouse/semi', '/warehouse/suppliers', '/warehouse/writeoffs',
  '/warehouse/supply-expenses', '/warehouse/history', '/warehouse/inventory-check',
  '/finance/cashflow', '/finance/pnl', '/finance/balance',
  '/finance/budget', '/finance/accounts', '/finance/payroll',
  '/analytics/abc-menu', '/analytics/abc-inventory', '/analytics/tables',
  '/analytics/waiters', '/analytics/food-cost', '/analytics/peak-hours',
  '/analytics/forecast',
  '/settings', '/settings/users', '/settings/printers',
  '/settings/import', '/settings/customers', '/settings/audit',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(PRECACHE_URLS.map(url => cache.add(url).catch(() => {})))
    )
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method !== 'GET') return

  // Skip non-http(s) schemes (chrome-extension, etc.)
  if (!url.protocol.startsWith('http')) return

  // Skip API calls to Supabase or local server — handled by IndexedDB/PGlite
  if (url.hostname.includes('supabase') || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return

  // Skip local server endpoints
  if (url.port === '3001' || url.port === '9111' || url.port === '8181') return

  // Static assets: cache-first
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|ico|webp|woff2?|css|js)$/)
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        }).catch(() => cached || new Response('', { status: 503 }))
      })
    )
    return
  }

  // RSC requests (?_rsc=xxx) and _next/data: network-first, cache fallback
  if (url.searchParams.has('_rsc') || url.pathname.startsWith('/_next/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            if (cached) return cached
            // RSC fallback: try the page without _rsc param
            const pageUrl = url.pathname
            return caches.match(pageUrl).then((pageCached) => {
              if (pageCached) return pageCached
              // Last resort: return cached root page
              return caches.match('/').then((root) =>
                root || new Response('offline', { status: 503 })
              )
            })
          })
        })
    )
    return
  }

  // HTML pages: network-first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => {
        return caches.match(event.request)
          .then((cached) => cached || caches.match('/'))
          .then((fallback) => fallback || new Response(
            '<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>RestOS</h2><p style="color:#999">Offline mode</p></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          ))
      })
  )
})
