// Service worker mínimo, só pra habilitar a instalação do sistema como app
// no celular (isso é exigido pelo navegador pra permitir "Adicionar à tela
// inicial"). De propósito, NÃO guarda em cache nada de dado do sistema —
// tudo continua vindo sempre ao vivo do Supabase, sem risco de mostrar
// informação desatualizada offline.
const CACHE_NOME = 'konsi-app-shell-v1';
const ARQUIVOS_ESTATICOS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NOME).then((cache) => cache.addAll(ARQUIVOS_ESTATICOS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE_NOME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Só os ícones (estáticos, nunca mudam) vêm do cache primeiro. Todo o
// resto — o index.html, e claro, tudo que fala com o Supabase — sempre
// busca da rede, nunca do cache, pra nunca mostrar dado antigo.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes('/icons/')) {
    event.respondWith(
      caches.match(event.request).then((resp) => resp || fetch(event.request))
    );
  }
  // demais requisições: comportamento padrão do navegador (rede), sem interceptar.
});

// ---------------- NOTIFICAÇÕES PUSH ----------------
// Chegam do servidor (função enviar-push) mesmo com o app fechado.
self.addEventListener('push', (event) => {
  let dados = {};
  try { dados = event.data ? event.data.json() : {}; } catch (e) { dados = { title: 'Konsi Jurídico', body: event.data ? event.data.text() : '' }; }
  const titulo = dados.title || 'Konsi Jurídico';
  event.waitUntil(self.registration.showNotification(titulo, {
    body: dados.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: dados.tag || undefined,
    data: { url: dados.url || './index.html' },
  }));
});

// Ao tocar: foca o app se já estiver aberto (e manda abrir o processo),
// senão abre o app já no processo.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const alvo = new URL((event.notification.data && event.notification.data.url) || './index.html', self.registration.scope).href;
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const j of janelas) {
      if (j.url.startsWith(self.registration.scope)) {
        await j.focus();
        j.postMessage({ tipo: 'abrir-url', url: alvo });
        return;
      }
    }
    await self.clients.openWindow(alvo);
  })());
});
