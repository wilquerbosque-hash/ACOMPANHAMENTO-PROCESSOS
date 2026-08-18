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
