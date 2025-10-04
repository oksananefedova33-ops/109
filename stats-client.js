// ui/stats/stats-client.js
(function(){
  'use strict';

  const API = (window.STATS_API || '/ui/stats/stats-api.php').replace(/\/+$/, '');

  function send(payload) {
    try {
      const data = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const blob = new Blob([data], { type: 'application/json' });
        return navigator.sendBeacon(`${API}?action=event`, blob);
      } else {
        return fetch(`${API}?action=event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          keepalive: true,
          credentials: 'omit',
          mode: 'cors'
        }).catch(()=>{});
      }
    } catch(e) {}
  }

  function isDownloadLink(a) {
    if (!a || !a.href) return false;
    if (a.hasAttribute('download')) return true;
    try {
      const url = new URL(a.href, location.href);
      const ext = (url.pathname.split('.').pop() || '').toLowerCase();
      return ['zip','rar','7z','pdf','doc','docx','xls','xlsx','ppt','pptx','dmg','exe','apk','mp3','mp4','mov','avi','mkv','csv'].includes(ext);
    } catch(e) { return false; }
  }

  function trackVisit() {
    try {
      send({
        type: 'visit',
        domain: location.hostname,
        url: location.href,
        path: location.pathname + location.search,
        referrer: document.referrer || ''
      });
    } catch(e) {}
  }

  function trackClicksAndDownloads() {
    document.addEventListener('click', function(ev){
      const a = ev.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      const absolute = new URL(href, location.href).href;
      send({
        type: isDownloadLink(a) ? 'download' : 'click',
        domain: location.hostname,
        url: location.href,
        path: absolute,
        referrer: document.referrer || ''
      });
    }, true);
  }

  trackVisit();
  trackClicksAndDownloads();
})();
