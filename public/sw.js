// Laundry Tracker Service Worker
// Handles background alarm scheduling, local notifications, and ntfy relay.

const alarms = {}; // id → array of timeout handles

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SET_ALARM') {
    const { id, endTime, title, body, topicId, followUps = [] } = data;

    // Clear any existing alarm for this id
    if (alarms[id]) { alarms[id].forEach(clearTimeout); delete alarms[id]; }
    alarms[id] = [];

    const scheduleOne = (fireTime, notifTitle, notifBody) => {
      const ms = Math.max(0, fireTime - Date.now());
      const t = setTimeout(async () => {
        // 1. Local notification (works when PWA is installed)
        try {
          await self.registration.showNotification(notifTitle, {
            body: notifBody,
            icon: '/icon-192.png',
            tag: id,
            renotify: true,
            requireInteraction: true,
          });
        } catch (_) {}

        // 2. Send via ntfy immediately (no Delay header — fires right now)
        if (topicId) {
          try {
            await fetch(`https://ntfy.sh/${topicId}`, {
              method: 'POST',
              headers: { Title: notifTitle, Priority: 'high', Tags: 'bell' },
              body: notifBody,
            });
          } catch (_) {}
        }

        // 3. Focus the app window if it's open in background
        try {
          const clients = await self.clients.matchAll({ type: 'window' });
          if (clients.length > 0) clients[0].postMessage({ type: 'ALARM_FIRED', id });
        } catch (_) {}
      }, ms);
      alarms[id].push(t);
    };

    scheduleOne(endTime, title, body);
    followUps.forEach(({ extraMs, title: t, body: b }) =>
      scheduleOne(endTime + extraMs, t, b)
    );

  } else if (data.type === 'CANCEL_ALARM') {
    const { id } = data;
    if (alarms[id]) { alarms[id].forEach(clearTimeout); delete alarms[id]; }
  }
});

// Bring app to foreground when notification is tapped
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
