self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
{
  id: 3,
  title: "Hees Soomaali",
  user: "SoomaaLink",
  videoUrl: "https://...mp4",
  likes: "10K"
}