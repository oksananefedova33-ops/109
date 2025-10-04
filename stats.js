// ui/stats/stats.js (host-agnostic)
(function(){
  'use strict';

  const STORAGE_KEY = 'stats_api_base';

  // Try to detect a working API base and cache it
  async function resolveApiBase() {
    // 1) cached
    const cached = (localStorage.getItem(STORAGE_KEY) || '').trim();
    if (cached) {
      if (await ping(cached)) return cached;
      localStorage.removeItem(STORAGE_KEY);
    }
    // 2) global
    const g = (window.STATS_API || '').replace(/\/+$/,'');
    if (g) {
      if (await ping(g)) { localStorage.setItem(STORAGE_KEY, g); return g; }
    }
    // 3) same-origin default
    const def = '/ui/stats/stats-api.php';
    if (await ping(def)) { localStorage.setItem(STORAGE_KEY, def); return def; }

    throw new Error('Не удалось определить адрес API статистики');
  }

  async function ping(base) {
    try {
      const res = await fetch(`${base}?action=ping`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!res.ok) return false;
      const j = await res.json().catch(()=>null);
      return !!(j && j.ok === true && j.pong === 'stats');
    } catch(e) { return false; }
  }

  // UI helpers
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k,v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c!=null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  }

  function addStatsButton() {
    try {
      const toolbar = document.querySelector('.topbar');
      if (!toolbar || document.getElementById('btnStats')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btnStats';
      btn.className = 'btn';
      btn.textContent = '📊 Статистика';
      btn.addEventListener('click', openStatsModal);
      const after = document.getElementById('btnRemoteSites');
      if (after && after.nextSibling) toolbar.insertBefore(btn, after.nextSibling);
      else toolbar.appendChild(btn);
    } catch(e) {}
  }

  // read host list from "Мои сайты", normalize to host
  function getConnectedDomains() {
    try {
      const arr = JSON.parse(localStorage.getItem('rs_domains') || '[]');
      return arr.map(x => {
        const u = String(x.url || x).trim();
        try { return new URL(u).hostname.replace(/^www\./,''); }
        catch(e) {
          return u.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
        }
      }).filter(Boolean);
    } catch(e) { return []; }
  }

  let state = {
    apiBase: null,
    domains: [],
    summary: null,
    events: [],
    activeTab: 'all'
  };

  async function openStatsModal() {
    state.domains = getConnectedDomains();
    state.activeTab = 'all';

    const overlay = el('div', { class: 'st-overlay', id: 'stOverlay' });
    const modal = el('div', { class: 'st-modal', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'st-modal__header' },
        el('div', { class: 'st-modal__title' }, '📊 Статистика — домены и общий счётчик'),
        el('div', null,
          el('span', { class: 'st-badge', title: 'Количество подключенных доменов' }, `Домены: ${state.domains.length || 0}`),
          el('button', { class: 'st-close', onclick: closeStatsModal, title: 'Закрыть' }, '×')
        )
      ),
      el('div', { class: 'st-modal__body' },
        el('div', { class: 'st-row' },
          el('div', { class: 'st-note' }, 'Показываются домены из «Мои сайты». Экспортируемые сайты отправляют события (визиты, клики, загрузки) в этот модуль.'),
          el('div', { class: 'st-right st-note' }, 'Метрики: уникальные посещения, клики, скачивания, источники, страны, IP.')
        ),
        el('div', { class: 'st-tabs', id: 'stTabs' },
          el('button', { class: 'st-tab active', 'data-tab': 'all', onclick: () => switchTab('all') }, 'Все домены'),
          ...state.domains.map(d => el('button', { class: 'st-tab', 'data-tab': d, title: d, onclick: () => switchTab(d) }, d))
        ),
        el('div', { id: 'stSummary' }, el('div', { class: 'st-row' }, el('div', { class:'st-note'}, 'Загрузка…')) ),
        el('div', { id: 'stEvents' })
      )
    );
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('active'));

    try {
      state.apiBase = await resolveApiBase();
    } catch(e) {
      const wrap = document.getElementById('stSummary');
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'st-card' }, el('h4', null, 'Ошибка'), el('div', null, String(e.message || e))));
      return;
    }

    await loadSummary();
    await loadEvents();
  }

  function closeStatsModal(){ const o=document.getElementById('stOverlay'); if(o) o.remove(); }
  function switchTab(tab){ state.activeTab = tab; document.querySelectorAll('.st-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab)); renderSummary(); loadEvents(); }

  async function loadSummary() {
    const wrap = document.getElementById('stSummary');
    try {
      const q = new URLSearchParams();
      q.set('action','summary');
      if (state.domains.length) q.set('domains', state.domains.join(','));
      const url = `${state.apiBase}?${q.toString()}`;
      const res = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
      const json = await res.json();
      if (json && json.ok) { state.summary = json; renderSummary(); }
      else throw new Error((json && json.error) || 'Ошибка загрузки статистики');
    } catch(e){
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'st-card' }, el('h4', null, 'Ошибка'), el('div', null, String(e.message || e))));
    }
  }

  function renderSummary() {
    const wrap = document.getElementById('stSummary');
    if (!wrap || !state.summary) return;
    const view = state.activeTab;
    wrap.innerHTML = '';
    const block = view === 'all' ? state.summary.overall : (state.summary.domains[view] || null);
    if (!block) { wrap.appendChild(el('div', { class: 'st-card' }, el('h4', null, 'Нет данных'), el('div', null, 'Для выбранного домена пока нет событий.'))); return; }
    const kpis = el('div', { class: 'st-grid' },
      metric('Уникальные посещения', block.unique_visitors),
      metric('Все визиты', block.visits),
      metric('Клики по ссылкам', block.clicks),
      metric('Скачивания файлов', block.downloads)
    );
    const refs = cardTable('Топ источников (referrer)', block.top_referrers, 'Источник');
    const countries = cardTable('Топ стран', block.top_countries, 'Страна');
    wrap.appendChild(kpis);
    wrap.appendChild(el('div', { class: 'st-grid' }, refs, countries));
  }

  function metric(title,value){return el('div',{class:'st-card'},el('h4',null,title),el('div',{class:'st-num'},String(value||0)));}
  function cardTable(title, dict, firstCol){
    const rows = Object.entries(dict||{}).map(([k,v]) => el('tr', null, el('td', null, k||'—'), el('td', null, String(v))));
    return el('div', { class:'st-card' }, el('h4', null, title),
      el('table',{class:'st-table'}, el('thead',null,el('tr',null,el('th',null,firstCol),el('th',null,'Кол-во'))), el('tbody',null,...rows) ));
  }

  async function loadEvents(){
    const wrap = document.getElementById('stEvents');
    try{
      const q = new URLSearchParams();
      q.set('action','events');
      if (state.activeTab !== 'all') q.set('domain', state.activeTab);
      q.set('limit','200');
      const res = await fetch(`${state.apiBase}?${q.toString()}`, { method:'GET', mode:'cors', credentials:'omit' });
      const json = await res.json();
      state.events = (json && json.ok) ? (json.events || []) : [];
      renderEvents();
    }catch(e){ state.events = []; renderEvents(); }
  }

  function renderEvents(){
    const wrap = document.getElementById('stEvents');
    if (!wrap) return;
    wrap.innerHTML = '';
    const header = el('div',{class:'st-row'}, el('div',{class:'st-note'},'Последние события (до 200). Для полноты смотрите агрегированные метрики выше.'));
    const tbody = el('tbody', null, ...(state.events||[]).map(ev => el('tr',null,
      el('td',null,ev.ts||''),
      el('td',null,ev.domain||''),
      el('td',null,ev.type||''),
      el('td',null,ev.item||ev.path||''),
      el('td',null,ev.referrer||'—'),
      el('td',null,ev.country||'—'),
      el('td',null,ev.ip||'—')
    )));
    const table = el('table',{class:'st-table'},
      el('thead',null, el('tr',null, el('th',null,'Время'), el('th',null,'Домен'), el('th',null,'Тип'), el('th',null,'Объект'), el('th',null,'Источник'), el('th',null,'Страна'), el('th',null,'IP') )),
      tbody
    );
    wrap.appendChild(header); wrap.appendChild(table);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') addStatsButton();
  else document.addEventListener('DOMContentLoaded', addStatsButton);
})();
