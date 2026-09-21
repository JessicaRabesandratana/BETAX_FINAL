(() => {
  'use strict';

  const DATA_URL = 'js/bus.json';
  const STOPS_URL = 'js/stops.json';
  const GEO_CACHE_KEY = 'final-betax-geocache-v1';
  const THEME_KEY = 'final-betax-theme-v1';
  const FAVORITES_KEY = 'final-betax-favorites-v1';
  const RECENTS_KEY = 'final-betax-recent-trips-v1';
  const ONBOARDING_KEY = 'final-betax-onboarding-v1';
  const MAX_RESULTS = 12;
  const DEFAULT_CENTER = [-18.8894, 47.5258];
  const TANA_BOUNDS = { south: -19.035, west: 47.365, north: -18.735, east: 47.675 };
  const TANA_LEAFLET_BOUNDS = [[TANA_BOUNDS.south, TANA_BOUNDS.west], [TANA_BOUNDS.north, TANA_BOUNDS.east]];
  const TANA_VIEWBOX = `${TANA_BOUNDS.west},${TANA_BOUNDS.north},${TANA_BOUNDS.east},${TANA_BOUNDS.south}`;
  const PLACE_ALIASES = {
    mahasina: 'mahamasina', maha: 'mahamasina', analakely: 'analakely', anosy: 'anosy',
    '67ha': '67 ha', '67 ha': '67 ha', ambondrona: 'ambondrona', analakely: 'analakely'
  };

  const state = {
    routes: [], stops: [], location: null, map: null, markersLayer: null, selectedLayer: null,
    userMarker: null, accuracyCircle: null, watchId: null, lastGeocodeAt: 0, mapFollowedUser: false,
    mapActiveRoute: null, mapKnownCount: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const text = (value = '') => String(value ?? '');
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function normalise(value = '') {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'")
      .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
  }

  function canonicalLocation(value = '') {
    const cleaned = normalise(value).replace(/\b(arrets?|stops?|quartier|lieu|zone|centre|ville|bus|ligne)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return PLACE_ALIASES[cleaned] || cleaned;
  }

  function slug(value = '') { return normalise(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function optionalNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
  function make(tag, className = '', content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }
  function button(label, className = '', onClick) {
    const el = make('button', className, label); el.type = 'button'; if (onClick) el.addEventListener('click', onClick); return el;
  }
  function link(label, href, className = '') { const el = make('a', className, label); el.href = href; return el; }
  function clear(el) { if (el) el.replaceChildren(); }

  function getJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
  function setJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* stockage indisponible */ } }

  // Theme
  function currentTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function notifyAndroidTheme(theme) { try { window.BetaxAndroid?.setTheme?.(theme); } catch (_) { /* Web */ } }
  function updateThemeButtons(theme) {
    $$('.theme-toggle').forEach((el) => {
      const dark = theme === 'dark';
      el.setAttribute('aria-pressed', String(dark));
      el.setAttribute('aria-label', dark ? 'Activer le mode clair' : 'Activer le mode sombre');
      const icon = $('.theme-icon', el); const label = $('.theme-label', el);
      if (icon) icon.textContent = dark ? '☀' : '☾'; if (label) label.textContent = dark ? 'Clair' : 'Sombre';
    });
  }
  function applyTheme(theme, persist = false) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; document.documentElement.style.colorScheme = next;
    const meta = $('meta[name="theme-color"]'); if (meta) meta.content = next === 'dark' ? '#071522' : '#0b9c83';
    if (persist) { try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* ignore */ } }
    updateThemeButtons(next); notifyAndroidTheme(next);
  }
  function initialiseTheme() {
    const actions = $('.header-actions');
    if (actions && !$('.theme-toggle', actions)) {
      const toggle = button('', 'theme-toggle');
      toggle.innerHTML = '<span class="theme-icon" aria-hidden="true">☾</span><span class="theme-label">Sombre</span>';
      actions.prepend(toggle);
      toggle.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
    }
    applyTheme(currentTheme(), false);
  }

  // Data parsing.
  function parseStop(rawStop) {
    const raw = text(rawStop).replace(/\s+/g, ' ').trim();
    const parts = raw.split(/\s*[-–—]\s*/).filter(Boolean);
    const name = (parts.length > 1 ? parts.slice(0, -1).join(' - ') : (parts[0] || raw)).trim();
    const place = (parts.length > 1 ? parts.at(-1) : '').trim();
    return { raw, name, place, label: place ? `${name} - ${place}` : name };
  }
  function buildStopsFromRoutes(routes) {
    const map = new Map();
    routes.forEach((route) => route.stops.forEach((raw) => {
      const parsed = parseStop(raw); if (!parsed.name) return;
      const id = slug(`${parsed.name}-${parsed.place}`) || `stop-${map.size + 1}`;
      const old = map.get(id) || { id, name: parsed.name, place: parsed.place, label: parsed.label, routes: [], latitude: null, longitude: null };
      old.routes.push(route.name); map.set(id, old);
    }));
    return [...map.values()].map((stop) => ({ ...stop, routes: unique(stop.routes).sort((a,b) => a.localeCompare(b, 'fr')) }));
  }
  async function loadData() {
    const routesResponse = await fetch(DATA_URL, { cache: 'no-store' });
    if (!routesResponse.ok) throw new Error(`Lecture des lignes impossible (${routesResponse.status}).`);
    const routes = await routesResponse.json();
    if (!Array.isArray(routes)) throw new Error('bus.json doit contenir une liste de lignes.');
    state.routes = routes.filter((r) => r && typeof r.name === 'string' && Array.isArray(r.stops)).map((r) => ({ name: r.name.trim(), stops: r.stops.filter((s) => typeof s === 'string' && s.trim()) }));
    try {
      const stopsResponse = await fetch(STOPS_URL, { cache: 'no-store' });
      if (!stopsResponse.ok) throw new Error('stops.json indisponible');
      const stops = await stopsResponse.json(); if (!Array.isArray(stops)) throw new Error('Format stops.json incorrect');
      state.stops = stops.filter((s) => s && typeof s.name === 'string').map((s) => ({
        id: s.id || slug(`${s.name}-${s.place || ''}`), name: s.name.trim(), place: text(s.place).trim(),
        label: s.label || (s.place ? `${s.name} - ${s.place}` : s.name), routes: unique(Array.isArray(s.routes) ? s.routes : []),
        latitude: optionalNumber(s.latitude), longitude: optionalNumber(s.longitude)
      }));
    } catch (_) { state.stops = buildStopsFromRoutes(state.routes); }
    updateCounters();
  }
  function updateCounters() {
    const routes = $('#routeCount'), stops = $('#stopCount'), saved = $('#savedCount');
    if (routes) routes.textContent = state.routes.length.toLocaleString('fr-FR');
    if (stops) stops.textContent = state.stops.length.toLocaleString('fr-FR');
    if (saved) saved.textContent = getFavorites().length.toLocaleString('fr-FR');
  }
  function showDataFailure(error) {
    ['#busResults','#stopResults','#journeyResults','#routeDetail','#mapStopResults'].forEach((selector) => {
      const el = $(selector); if (el) { clear(el); el.append(make('p', 'info-message', `Données indisponibles : ${error.message || error}`)); }
    });
  }

  // Search.
  function routeMatches(query) {
    const cleaned = normalise(query); if (!cleaned) return [];
    return state.routes.filter((route) => normalise(route.name).includes(cleaned));
  }
  function scoreStop(stop, query) {
    const cleaned = canonicalLocation(query); if (!cleaned) return 0;
    const name = canonicalLocation(stop.name), place = canonicalLocation(stop.place), label = canonicalLocation(stop.label);
    const tokens = cleaned.split(' ').filter((t) => t.length > 1);
    if (name === cleaned || place === cleaned || label === cleaned) return 100;
    if (place.includes(cleaned)) return 88; if (name.includes(cleaned) || label.includes(cleaned)) return 78;
    const found = tokens.filter((t) => label.includes(t)).length; return tokens.length && found === tokens.length ? 50 + found : 0;
  }
  function stopMatches(query, limit = MAX_RESULTS) {
    return state.stops.map((stop) => ({ stop, score: scoreStop(stop, query) })).filter(({score}) => score > 0)
      .sort((a,b) => b.score - a.score || a.stop.label.localeCompare(b.stop.label, 'fr')).slice(0, limit).map(({stop}) => stop);
  }
  function routeByName(name) { return state.routes.find((route) => normalise(route.name) === normalise(name)); }
  function routeLink(route) { return `ligne.html?line=${encodeURIComponent(route.name)}`; }
  function mapLinkForStop(stop) { return `map.html?stop=${encodeURIComponent(stop.id)}`; }
  function mapLinkForRoute(route) { return `map.html?line=${encodeURIComponent(route.name)}`; }

  // Favorites and history.
  function getFavorites() { const list = getJSON(FAVORITES_KEY, []); return Array.isArray(list) ? list : []; }
  function isFavorite(type, id) { return getFavorites().some((item) => item.type === type && normalise(item.id) === normalise(id)); }
  function toggleFavorite(type, id, label) {
    const items = getFavorites(); const index = items.findIndex((item) => item.type === type && normalise(item.id) === normalise(id));
    if (index >= 0) items.splice(index, 1); else items.unshift({ type, id, label, createdAt: new Date().toISOString() });
    setJSON(FAVORITES_KEY, items.slice(0, 24)); updateCounters(); renderSavedSections(); return index < 0;
  }
  function favoriteButton(type, id, label) {
    const saved = isFavorite(type, id); const btn = button(saved ? '★ Favori' : '☆ Ajouter', 'favorite-button');
    btn.setAttribute('aria-pressed', String(saved));
    btn.addEventListener('click', () => { const nowSaved = toggleFavorite(type, id, label); btn.textContent = nowSaved ? '★ Favori' : '☆ Ajouter'; btn.setAttribute('aria-pressed', String(nowSaved)); });
    return btn;
  }
  function getRecents() { const list = getJSON(RECENTS_KEY, []); return Array.isArray(list) ? list : []; }
  function saveRecentTrip(from, to) {
    const item = { from: text(from).trim(), to: text(to).trim(), stamp: Date.now() }; if (!item.from || !item.to) return;
    const list = getRecents().filter((old) => !(normalise(old.from) === normalise(item.from) && normalise(old.to) === normalise(item.to)));
    list.unshift(item); setJSON(RECENTS_KEY, list.slice(0, 6)); renderSavedSections();
  }
  function renderSavedSections() {
    const holders = $$('#homeSaved, #journeySaved'); if (!holders.length) return;
    const favorites = getFavorites(), recents = getRecents();
    holders.forEach((holder) => {
      clear(holder); const section = make('section', 'saved-card');
      const heading = make('div', 'section-intro'); const h = make('div'); h.append(make('p','eyebrow','À portée de main'), make('h2','','Favoris et trajets récents')); heading.append(h); section.append(heading);
      const layout = make('div','saved-layout');
      const fav = make('div','saved-column'); fav.append(make('h3','','Mes favoris'));
      if (!favorites.length) fav.append(make('p','muted','Ajoutez une ligne ou un arrêt avec l’étoile pour le retrouver ici.'));
      favorites.slice(0, 6).forEach((item) => {
        const href = item.type === 'route' ? `ligne.html?line=${encodeURIComponent(item.id)}` : item.type === 'stop' ? `arret.html?stop=${encodeURIComponent(item.id)}` : 'trajet.html';
        const row = link(`${item.type === 'route' ? '🚌' : item.type === 'stop' ? '⌖' : '⌁'} ${item.label}`, href, 'saved-row');
        fav.append(row);
      });
      const recent = make('div','saved-column'); recent.append(make('h3','','Derniers trajets'));
      if (!recents.length) recent.append(make('p','muted','Vos recherches de trajet récentes apparaîtront ici.'));
      recents.slice(0, 6).forEach((item) => {
        const row = button(`${item.from} → ${item.to}`, 'saved-row'); row.addEventListener('click', () => { window.location.href = `trajet.html?from=${encodeURIComponent(item.from)}&to=${encodeURIComponent(item.to)}`; }); recent.append(row);
      });
      layout.append(fav, recent); section.append(layout); holder.append(section);
    });
  }

  // Render basic search pages.
  function renderRouteResults(container, routes, query) {
    clear(container);
    if (!query) { container.append(make('p','empty-state','Entrez une ligne, par exemple « 109 » ou « 147 Bis ».')); return; }
    if (!routes.length) { container.append(make('p','empty-state',`Aucune ligne trouvée pour « ${query} ».`)); return; }
    routes.forEach((route) => {
      const card = make('article','result-card route-result'); const top = make('div','result-top');
      const title = make('div'); title.append(make('p','eyebrow','Ligne'), make('h2','',`🚌 ${route.name}`)); top.append(title, favoriteButton('route',route.name,`Ligne ${route.name}`)); card.append(top);
      card.append(make('p','',`${route.stops.length} arrêts répertoriés. Ouvrez la fiche pour consulter la séquence complète.`));
      const preview = make('div','chip-list'); route.stops.slice(0, 6).forEach((raw) => { const p = parseStop(raw); preview.append(link(p.label, `arret.html?stop=${encodeURIComponent(p.place || p.name)}`, 'chip')); }); card.append(preview);
      const actions = make('div','result-card-actions'); actions.append(link('Voir le détail', routeLink(route), 'button button-primary'), link('Carte', mapLinkForRoute(route), 'button button-secondary')); card.append(actions); container.append(card);
    });
  }
  function renderStopResults(container, stops, query) {
    clear(container);
    if (!query) { container.append(make('p','empty-state','Entrez un arrêt ou un quartier, par exemple « Analakely ».')); return; }
    if (!stops.length) { container.append(make('p','empty-state',`Aucun arrêt trouvé pour « ${query} ». Essayez une orthographe plus courte.`)); return; }
    stops.forEach((stop) => {
      const card = make('article','result-card'); const top = make('div','result-top'); const title = make('div'); title.append(make('p','eyebrow','Arrêt'),make('h2','',`⌖ ${stop.name}`)); if (stop.place) title.append(make('p','muted',stop.place)); top.append(title,favoriteButton('stop',stop.id,stop.label)); card.append(top);
      const chips = make('div','chip-list'); stop.routes.slice(0,18).forEach((name) => chips.append(link(`🚌 ${name}`,`ligne.html?line=${encodeURIComponent(name)}`,'chip'))); card.append(chips);
      const actions = make('div','result-card-actions'); actions.append(link('Voir sur la carte',mapLinkForStop(stop),'button button-secondary'), link('Partir d’ici',`trajet.html?from=${encodeURIComponent(stop.place || stop.name)}`,'button button-ghost')); card.append(actions); container.append(card);
    });
  }
  function initialiseBusPage() {
    const form = $('#busSearchForm'), input = $('#busInput'), results = $('#busResults'); if (!form || !input || !results) return;
    const q = new URLSearchParams(location.search).get('line'); if (q) input.value = q;
    const go = () => renderRouteResults(results, routeMatches(input.value), input.value.trim()); form.addEventListener('submit',(e)=>{e.preventDefault();go();}); if(input.value)go();
    const popular = $('#popularRoutes'); if (popular) {
      const sample = state.routes.slice(0, 8); sample.forEach((route) => { const chip = button(route.name,'browse-chip',()=>{ input.value=route.name;go(); }); popular.append(chip); });
    }
  }
  function initialiseStopPage() {
    const form = $('#stopSearchForm'), input = $('#stopInput'), results = $('#stopResults'); if (!form || !input || !results) return;
    const q = new URLSearchParams(location.search).get('stop'); if(q)input.value=q;
    const go=()=>renderStopResults(results,stopMatches(input.value),input.value.trim());form.addEventListener('submit',(e)=>{e.preventDefault();go();});if(input.value)go();
  }
  function initialiseRouteDetail() {
    const holder = $('#routeDetail'); if (!holder) return; const name = new URLSearchParams(location.search).get('line'); const route = name && routeByName(name);
    clear(holder); if (!route) { holder.append(make('div','empty-state large-empty','Cette ligne est introuvable. Retournez à la recherche des lignes.')); return; }
    const intro = make('section','route-header-card'); const top = make('div','route-header-top'); const title = make('div'); title.append(make('p','eyebrow','Fiche de ligne'), make('h1','',`Ligne ${route.name}`), make('p','',`${route.stops.length} arrêts sont listés dans l'ordre fourni par les données Betax.`)); top.append(title, favoriteButton('route',route.name,`Ligne ${route.name}`)); intro.append(top);
    const actions = make('div','result-card-actions'); actions.append(link('Afficher sur la carte',mapLinkForRoute(route),'button button-primary'),link('Planifier un trajet',`trajet.html?from=${encodeURIComponent(parseStop(route.stops[0]).place || parseStop(route.stops[0]).name)}`,'button button-secondary')); intro.append(actions); holder.append(intro);
    const note = make('aside','data-note'); note.append(make('strong','', 'À savoir : '), document.createTextNode('les données ne précisent pas le sens officiel, les horaires ni le tarif. Vérifiez le terminus affiché sur le bus.')); holder.append(note);
    const list = make('ol','route-stop-list'); route.stops.forEach((raw,index) => { const p = parseStop(raw); const item=make('li','route-stop'); const number=make('span','route-step',String(index+1)); const info=make('div'); info.append(make('strong','',p.name)); if(p.place)info.append(make('small','',p.place)); const actions=make('div','route-stop-actions'); const found=stopMatches(p.label,1)[0] || stopMatches(p.place || p.name,1)[0]; if(found) actions.append(link('Carte',mapLinkForStop(found),'mini-link')); item.append(number,info,actions); list.append(item); }); holder.append(list);
  }

  // Trip planning.
  function rawMatchesQuery(raw, query) {
    const parsed = parseStop(raw); const cleaned = canonicalLocation(query); if (!cleaned) return false;
    const candidates = [parsed.name, parsed.place, parsed.label, raw].map(canonicalLocation); return candidates.some((candidate) => candidate === cleaned || candidate.includes(cleaned));
  }
  function routePositions(route, query) { return route.stops.map((raw,index) => rawMatchesQuery(raw,query) ? index : -1).filter((index)=>index>=0); }
  function directCandidates(from, to) {
    return state.routes.map((route) => {
      const fromPositions = routePositions(route, from), toPositions = routePositions(route, to); if (!fromPositions.length || !toPositions.length) return null;
      let pair = null; fromPositions.forEach((a)=>toPositions.forEach((b)=>{ if (!pair || Math.abs(b-a) < Math.abs(pair.to-pair.from)) pair={from:a,to:b}; }));
      return { route, ...pair, fromPositions, toPositions };
    }).filter(Boolean).sort((a,b)=>Math.abs(a.to-a.from)-Math.abs(b.to-b.from));
  }
  function stopSignature(raw) { const p=parseStop(raw); return `${canonicalLocation(p.name)}|${canonicalLocation(p.place)}`; }
  function transferCandidates(from, to) {
    const origin = state.routes.filter((route)=>routePositions(route,from).length); const destination=state.routes.filter((route)=>routePositions(route,to).length); const candidates=[];
    origin.forEach((first)=>destination.forEach((second)=>{
      if(first.name===second.name) return;
      const lookup=new Map(second.stops.map((raw,index)=>[stopSignature(raw),{raw,index}]));
      first.stops.forEach((raw,index)=>{const hit=lookup.get(stopSignature(raw)); if(hit && canonicalLocation(raw)!==canonicalLocation(from) && canonicalLocation(raw)!==canonicalLocation(to)) candidates.push({first,second,change:parseStop(raw),fromIndex:index,toIndex:hit.index});});
    }));
    const seen=new Set(); return candidates.filter((candidate)=>{const key=`${candidate.first.name}|${candidate.second.name}|${candidate.change.label}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,5);
  }
  function ambiguousMessage(query, matches) { return `Je trouve plusieurs résultats pour « ${query} » : ${matches.slice(0,3).map((stop)=>stop.label).join(' ; ')}. Choisissez un nom plus précis.`; }
  function ambiguousPlaces(query, stops) {
    const exact = stops.filter((stop) => scoreStop(stop, query) >= 95);
    const places = unique(exact.map((stop) => canonicalLocation(stop.place || stop.name)));
    return places.length > 1 ? exact : [];
  }
  function planTrip(from, to) {
    const originStops=stopMatches(from,5), destStops=stopMatches(to,5);
    if(!originStops.length && !destStops.length) return {kind:'error', title:'Lieux non trouvés', text:`Je ne trouve ni « ${from} » ni « ${to} » dans les données Betax.`, originStops, destStops};
    if(!originStops.length) return {kind:'error', title:'Départ introuvable', text:`Je trouve la destination « ${to} », mais pas le départ « ${from} ».`, originStops, destStops};
    if(!destStops.length) return {kind:'error', title:'Destination introuvable', text:`Je trouve le départ « ${from} », mais pas la destination « ${to} ».`, originStops, destStops};
    const ambiguousOrigin = ambiguousPlaces(from, originStops);
    if (ambiguousOrigin.length) return {kind:'ambiguous', field:'from', from, to, matches:ambiguousOrigin};
    const ambiguousDestination = ambiguousPlaces(to, destStops);
    if (ambiguousDestination.length) return {kind:'ambiguous', field:'to', from, to, matches:ambiguousDestination};
    const direct=directCandidates(from,to); const transfers=direct.length ? [] : transferCandidates(from,to);
    return {kind:direct.length?'direct':transfers.length?'transfer':'none', from, to, originStops, destStops, direct, transfers};
  }
  function renderTripResult(container, plan) {
    clear(container);
    if(plan.kind==='error') { const card=make('article','trip-card trip-error');card.append(make('p','eyebrow','Recherche à préciser'),make('h2','',plan.title),make('p','',plan.text));const groups=[['Départ',plan.originStops],['Destination',plan.destStops]];groups.forEach(([label,stops])=>{if(stops?.length){const row=make('div','choice-row');row.append(make('strong','',`${label} :`));stops.slice(0,3).forEach((stop)=>row.append(link(stop.label,`arret.html?stop=${encodeURIComponent(stop.place||stop.name)}`,'chip')));card.append(row);}});container.append(card);return; }
    if(plan.kind==='ambiguous') { const label=plan.field==='from'?'départ':'destination'; const card=make('article','trip-card trip-error'); card.append(make('p','eyebrow','Choix nécessaire'),make('h2','',`Précisez le ${label}`),make('p','',`Plusieurs lieux Betax correspondent à « ${plan.field==='from'?plan.from:plan.to} ». Sélectionnez celui que vous voulez utiliser.`)); const row=make('div','choice-row'); plan.matches.slice(0,5).forEach((stop)=>{const value=stop.place||stop.name;const href=plan.field==='from'?`trajet.html?from=${encodeURIComponent(value)}&to=${encodeURIComponent(plan.to)}`:`trajet.html?from=${encodeURIComponent(plan.from)}&to=${encodeURIComponent(value)}`;row.append(link(stop.label,href,'chip'));});card.append(row);container.append(card);return; }
    const header=make('section','trip-summary'); header.append(make('p','eyebrow',plan.kind==='direct'?'Trajet direct trouvé':'Résultat de recherche'),make('h2','',`${plan.from} → ${plan.to}`));
    if(plan.kind==='direct') header.append(make('p','',`Les lignes ci-dessous contiennent le départ et la destination dans le même parcours du fichier. Vérifiez le terminus et le sens avant de monter.`));
    else if(plan.kind==='transfer') header.append(make('p','',`Aucune ligne directe n'est confirmée dans les données. Betax a trouvé des arrêts communs possibles entre certaines lignes.`));
    else header.append(make('p','',`Aucune ligne directe ni correspondance fiable n'est visible dans les données actuelles. Utilisez les fiches d'arrêt pour explorer les lignes disponibles.`));
    container.append(header);
    if(plan.kind==='direct') { const list=make('div','trip-list');plan.direct.slice(0,8).forEach((candidate)=>{const card=make('article','trip-card direct');const top=make('div','trip-card-top');const title=make('div');title.append(make('span','trip-badge','Direct - à vérifier'),make('h3','',`🚌 Ligne ${candidate.route.name}`),make('p','',`Arrêt de départ et destination présents dans la même liste de parcours.`));top.append(title,favoriteButton('route',candidate.route.name,`Ligne ${candidate.route.name}`));card.append(top);const actions=make('div','result-card-actions');actions.append(link('Fiche ligne',routeLink(candidate.route),'button button-primary'),link('Carte',mapLinkForRoute(candidate.route),'button button-secondary'));card.append(actions);list.append(card);});container.append(list); }
    if(plan.kind==='transfer') { const list=make('div','trip-list');plan.transfers.forEach((candidate)=>{const card=make('article','trip-card transfer');card.append(make('span','trip-badge warning','Correspondance suggérée'),make('h3','',`🚌 ${candidate.first.name} → ${candidate.second.name}`),make('p','',`Correspondance possible à « ${candidate.change.label} », car cet arrêt apparaît dans les deux lignes.`),make('p','trip-caution','Vérifiez sur place la direction, le terminus et la disponibilité de chaque ligne.'));const actions=make('div','result-card-actions');actions.append(link(`Ligne ${candidate.first.name}`,routeLink(candidate.first),'button button-secondary'),link(`Ligne ${candidate.second.name}`,routeLink(candidate.second),'button button-secondary'));list.append(card);});container.append(list); }
    if(plan.kind==='none'){const card=make('article','trip-card');card.append(make('h3','','Pistes à explorer'),make('p','',`Au départ : ${unique(plan.originStops.flatMap((s)=>s.routes)).slice(0,10).join(', ') || 'aucune ligne'}.
À destination : ${unique(plan.destStops.flatMap((s)=>s.routes)).slice(0,10).join(', ') || 'aucune ligne'}.`));container.append(card);}
  }
  function initialiseJourney() {
    const form=$('#journeyForm'), from=$('#journeyFrom'), to=$('#journeyTo'), result=$('#journeyResults'), status=$('#journeyStatus'); if(!form||!from||!to||!result)return;
    const params=new URLSearchParams(location.search); from.value=params.get('from')||'';to.value=params.get('to')||'';
    const go=()=>{const a=from.value.trim(),b=to.value.trim(); if(!a||!b){status.textContent='Indiquez un départ et une destination.';return;} const plan=planTrip(a,b);status.textContent=plan.kind==='direct'?'Lignes communes trouvées dans les données.':plan.kind==='transfer'?'Correspondances visibles dans les données.':'Résultat à vérifier.';renderTripResult(result,plan);saveRecentTrip(a,b);};
    form.addEventListener('submit',(e)=>{e.preventDefault();go();});$('#journeySwap')?.addEventListener('click',()=>{const temp=from.value;from.value=to.value;to.value=temp;from.focus();});$$('[data-journey-preset]').forEach((el)=>el.addEventListener('click',()=>{const [a,b]=el.dataset.journeyPreset.split('|');from.value=a;to.value=b;go();}));
    $('#journeyLocate')?.addEventListener('click',async()=>{status.textContent='Recherche de votre position...';try{const pos=await requestLocationOnce(); if(!isWithinTana(pos.coords.latitude,pos.coords.longitude)){status.textContent='Votre position est hors du périmètre Antananarivo.';return;}state.location={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy};const nearby=nearbyStops();if(!nearby.length){status.textContent='Position reçue. Aucun arrêt déjà géocodé n’est disponible près de vous.';return;}from.value=nearby[0].stop.place||nearby[0].stop.name;status.textContent=`Départ suggéré : ${nearby[0].stop.label}.`; }catch(error){status.textContent=locationErrorText(error);}});
    if(from.value&&to.value)go();renderSavedSections();
  }
  function initialiseQuickJourney() {
    const form=$('#quickJourneyForm'),from=$('#quickFrom'),to=$('#quickTo');if(!form||!from||!to)return;
    form.addEventListener('submit',(e)=>{e.preventDefault();window.location.href=`trajet.html?from=${encodeURIComponent(from.value.trim())}&to=${encodeURIComponent(to.value.trim())}`;});
    $$('[data-swap-journey]').forEach((el)=>el.addEventListener('click',()=>{const t=from.value;from.value=to.value;to.value=t;}));$$('[data-quick-trip]').forEach((el)=>el.addEventListener('click',()=>{const [a,b]=el.dataset.quickTrip.split('|');from.value=a;to.value=b;form.requestSubmit();}));
  }

  // Map and GPS.
  function isWithinTana(lat, lon) { return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=TANA_BOUNDS.south&&lat<=TANA_BOUNDS.north&&lon>=TANA_BOUNDS.west&&lon<=TANA_BOUNDS.east; }
  function getGeocodeCache(){return getJSON(GEO_CACHE_KEY,{});} function setGeocodeCache(cache){setJSON(GEO_CACHE_KEY,cache);}
  function cachedCoordinates(stop){if(isWithinTana(stop.latitude,stop.longitude))return {latitude:stop.latitude,longitude:stop.longitude,source:'données vérifiées'};const c=getGeocodeCache()[stop.id];return c&&isWithinTana(c.latitude,c.longitude)?c:null;}
  function stopIcon(){return L.divIcon({className:'',html:'<div class="stop-marker"><span>⌖</span></div>',iconSize:[28,28],iconAnchor:[14,27],popupAnchor:[0,-24]});}
  function userIcon(){return L.divIcon({className:'',html:'<div class="user-marker"></div>',iconSize:[22,22],iconAnchor:[11,11]});}
  function popupForStop(stop){return `<div class="map-popup"><strong>${escapeHTML(stop.name)}</strong><span>${escapeHTML(stop.place||'Arrêt Betax')}</span><small>Lignes : ${escapeHTML(stop.routes.slice(0,10).join(', ')||'non indiquées')}</small></div>`;}
  function escapeHTML(value){return text(value).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function renderMapMarkers(routeName=null){if(!state.map||!state.markersLayer)return;state.markersLayer.clearLayers();let count=0;state.stops.filter((stop)=>!routeName||stop.routes.includes(routeName)).forEach((stop)=>{const c=cachedCoordinates(stop);if(!c)return;L.marker([c.latitude,c.longitude],{icon:stopIcon()}).bindPopup(popupForStop(stop)).addTo(state.markersLayer);count++;});state.mapKnownCount=count;const counter=$('#mapStopCount');if(counter)counter.textContent=`${count} arrêt${count>1?'s':''} géolocalisé${count>1?'s':''}`;}
  function updateLocationStatus(msg){const status=$('#locationStatus');if(status)status.textContent=msg;}
  function updateUserPosition(position){const lat=position.coords.latitude,lon=position.coords.longitude;if(!isWithinTana(lat,lon)){updateLocationStatus('Votre position est hors du périmètre Antananarivo ; elle n’est pas affichée.');return;}state.location={latitude:lat,longitude:lon,accuracy:position.coords.accuracy};if(!state.map)return;const point=[lat,lon];if(!state.userMarker)state.userMarker=L.marker(point,{icon:userIcon(),zIndexOffset:1000}).addTo(state.map);else state.userMarker.setLatLng(point);if(!state.accuracyCircle)state.accuracyCircle=L.circle(point,{radius:Math.max(8,position.coords.accuracy),color:'#1c73ed',fillColor:'#1c73ed',fillOpacity:.12,weight:1}).addTo(state.map);else state.accuracyCircle.setLatLng(point).setRadius(Math.max(8,position.coords.accuracy));if(!state.mapFollowedUser){state.map.setView(point,15,{animate:true});state.mapFollowedUser=true;}updateLocationStatus(`Position active - précision environ ${Math.round(position.coords.accuracy)} m.`);}
  function locationErrorText(error){if(error?.code===1)return 'La localisation a été refusée. Vous pouvez toujours rechercher un arrêt manuellement.';if(error?.code===2)return 'La position est indisponible pour le moment.';if(error?.code===3)return 'La localisation a pris trop de temps. Réessayez.';return 'La localisation n’est pas disponible sur cet appareil.';}
  function requestLocationOnce(){return new Promise((resolve,reject)=>{if(!navigator.geolocation){reject(new Error('géolocalisation non prise en charge'));return;}navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:12000,maximumAge:30000});});}
  function startTracking(){if(!navigator.geolocation){updateLocationStatus('La géolocalisation n’est pas prise en charge sur cet appareil.');return;}if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;updateLocationStatus('Suivi de position arrêté.');const btn=$('#locateButton');if(btn)btn.textContent='⌖ Me localiser';return;}updateLocationStatus('Demande de localisation...');state.watchId=navigator.geolocation.watchPosition(updateUserPosition,(error)=>updateLocationStatus(locationErrorText(error)),{enableHighAccuracy:true,maximumAge:10000,timeout:15000});const btn=$('#locateButton');if(btn)btn.textContent='■ Arrêter le suivi';}
  function distanceMeters(a,b){const rad=(v)=>v*Math.PI/180;const r=6371000;const dLat=rad(b.latitude-a.latitude),dLon=rad(b.longitude-a.longitude);const h=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLon/2)**2;return 2*r*Math.asin(Math.sqrt(h));}
  function nearbyStops(){if(!state.location)return[];return state.stops.map((stop)=>{const c=cachedCoordinates(stop);return c?{stop,distance:distanceMeters(state.location,c)}:null;}).filter(Boolean).sort((a,b)=>a.distance-b.distance).slice(0,8);}
  async function geocodeStop(stop){const cached=cachedCoordinates(stop);if(cached)return cached;const wait=Math.max(0,1100-(Date.now()-state.lastGeocodeAt));if(wait)await sleep(wait);const url=new URL('https://nominatim.openstreetmap.org/search');url.search=new URLSearchParams({format:'jsonv2',limit:'1',countrycodes:'mg',bounded:'1',viewbox:TANA_VIEWBOX,q:[stop.name,stop.place,'Antananarivo','Madagascar'].filter(Boolean).join(', ')}).toString();state.lastGeocodeAt=Date.now();const response=await fetch(url);if(!response.ok)throw new Error(`Service cartographique indisponible (${response.status}).`);const data=await response.json();if(!Array.isArray(data)||!data[0])throw new Error('Aucune position précise trouvée dans Antananarivo.');const coordinates={latitude:Number(data[0].lat),longitude:Number(data[0].lon),source:'recherche cartographique'};if(!isWithinTana(coordinates.latitude,coordinates.longitude))throw new Error('Le résultat est hors Antananarivo et a été ignoré.');const cache=getGeocodeCache();cache[stop.id]=coordinates;setGeocodeCache(cache);return coordinates;}
  async function locateStopOnMap(stop){const result=$('#mapStopResults');if(!state.map)return;clear(result);result.append(make('p','loading-inline','Localisation de l’arrêt...'));try{const c=await geocodeStop(stop);state.selectedLayer.clearLayers();const marker=L.marker([c.latitude,c.longitude],{icon:stopIcon()}).bindPopup(popupForStop(stop)).addTo(state.selectedLayer);state.map.setView([c.latitude,c.longitude],16,{animate:true});marker.openPopup();renderMapMarkers(state.mapActiveRoute);clear(result);result.append(make('p','info-message',`« ${stop.label} » est affiché sur la carte (${c.source}).`));}catch(error){clear(result);result.append(make('p','info-message',error.message||'Impossible de localiser cet arrêt.'));}}
  function renderMapSearch(query){const result=$('#mapStopResults');const matches=stopMatches(query,8);clear(result);if(!query){result.append(make('p','muted','Saisissez un arrêt pour le rechercher dans Antananarivo.'));return;}if(!matches.length){result.append(make('p','muted',`Aucun arrêt local trouvé pour « ${query} ».`));return;}matches.forEach((stop)=>{const row=button('', 'map-stop-option',()=>locateStopOnMap(stop));row.append(make('strong','',stop.name),make('small','',`${stop.place||'Antananarivo'} - ${stop.routes.slice(0,4).join(', ')||'ligne non indiquée'}`));result.append(row);});}
  function renderMapRoute(name){const result=$('#mapStopResults');const routes=routeMatches(name);clear(result);if(!name){result.append(make('p','muted','Saisissez le numéro d’une ligne pour lister ses arrêts.'));return;}if(!routes.length){result.append(make('p','muted',`Aucune ligne trouvée pour « ${name} ».`));return;}const route=routes[0];state.mapActiveRoute=route.name;renderMapMarkers(route.name);result.append(make('p','info-message',`Ligne ${route.name} : ${route.stops.length} arrêts listés. Seuls les arrêts déjà géolocalisés sont marqués automatiquement.`));route.stops.slice(0,20).forEach((raw)=>{const parsed=parseStop(raw);const stop=stopMatches(parsed.label,1)[0]||stopMatches(parsed.place||parsed.name,1)[0];if(stop){const row=button(parsed.label,'map-stop-option',()=>locateStopOnMap(stop));result.append(row);}});}
  function initialiseMap(){if(!window.L){const map=$('#map');if(map)map.innerHTML='<div class="map-fallback">La carte interactive nécessite une connexion pour charger son fond. Les données Betax restent accessibles hors ligne.</div>';return;}state.map=L.map('map',{maxBounds:TANA_LEAFLET_BOUNDS,maxBoundsViscosity:1,minZoom:12,zoomControl:true,worldCopyJump:false}).setView(DEFAULT_CENTER,13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,minZoom:12,noWrap:true,bounds:TANA_LEAFLET_BOUNDS,attribution:'© OpenStreetMap contributors'}).addTo(state.map);L.rectangle(TANA_LEAFLET_BOUNDS,{color:'#0ba786',weight:1,fillOpacity:.03,interactive:false}).addTo(state.map);state.markersLayer=L.layerGroup().addTo(state.map);state.selectedLayer=L.layerGroup().addTo(state.map);renderMapMarkers();
    $('#locateButton')?.addEventListener('click',startTracking);$('#nearbyButton')?.addEventListener('click',()=>{const result=$('#mapStopResults');clear(result);if(!state.location){result.append(make('p','muted','Activez « Me localiser » pour afficher les arrêts proches.'));return;}const list=nearbyStops();if(!list.length){result.append(make('p','muted','Aucun arrêt déjà géocodé n’est disponible autour de vous. Recherchez d’abord un arrêt précis.'));return;}list.forEach(({stop,distance})=>result.append(button(`${stop.label} - ${Math.round(distance)} m`,'map-stop-option',()=>locateStopOnMap(stop))));});$('#knownStopsButton')?.addEventListener('click',()=>{state.mapActiveRoute=null;renderMapMarkers();const result=$('#mapStopResults');clear(result);result.append(make('p','info-message',`${state.mapKnownCount} arrêt(s) disposant de coordonnées sont affichés.`));});$('#resetMapButton')?.addEventListener('click',()=>{state.mapActiveRoute=null;state.selectedLayer.clearLayers();renderMapMarkers();state.map.setView(DEFAULT_CENTER,13,{animate:true});const result=$('#mapStopResults');clear(result);result.append(make('p','muted','Carte réinitialisée sur Antananarivo.'));});const stopForm=$('#mapStopForm'),stopInput=$('#mapStopInput');stopForm?.addEventListener('submit',(e)=>{e.preventDefault();renderMapSearch(stopInput.value.trim());});const lineForm=$('#mapLineForm'),lineInput=$('#mapLineInput');lineForm?.addEventListener('submit',(e)=>{e.preventDefault();renderMapRoute(lineInput.value.trim());});const params=new URLSearchParams(location.search);const stopId=params.get('stop'),line=params.get('line');if(stopId){const stop=state.stops.find((s)=>s.id===stopId);if(stop)locateStopOnMap(stop);}else if(line){lineInput.value=line;renderMapRoute(line);}}

  // Assistant - deterministic and bounded to Betax data.
  function extractTrip(question){const q=normalise(question);const patterns=[
    /(?:je\s+(?:me\s+)?(?:situe|trouve)|je\s+suis|je\s+pars)\s+(?:a|à|de|depuis)\s+(.+?)\s+(?:et\s+(?:que\s+)?)?(?:je\s+)?(?:veux|voudrais|souhaite|dois)?\s*(?:aller|partir|me\s+rendre|venir)\s+(?:a|à|vers|pour)\s+(.+?)(?:[?.!]|$)/,
    /(?:de|depuis|a\s+partir\s+de|à\s+partir\s+de)\s+(.+?)\s+(?:vers|pour|a|à|jusqu(?:a|à))\s+(.+?)(?:[?.!]|$)/,
    /(?:aller|partir|me\s+rendre)\s+(?:de|depuis)\s+(.+?)\s+(?:vers|pour|a|à)\s+(.+?)(?:[?.!]|$)/,
    /^(.+?)\s*(?:->|→)\s*(.+?)(?:[?.!]|$)/
  ];for(const pattern of patterns){const hit=q.match(pattern);if(hit){const from=cleanEndpoint(hit[1]),to=cleanEndpoint(hit[2]);if(from&&to&&from!==to)return{from,to};}}return null;}
  function cleanEndpoint(value){return canonicalLocation(text(value).replace(/\b(quel|quelle|quels|bus|ligne|prendre|devrais|dois|svp|stp|merci|s'il\s*te\s*plait)\b/g,' ').replace(/\s+/g,' ').trim());}
  function assistantHelp(){return ['Je réponds uniquement avec les données Betax :','• « Ligne 109 »','• « Quel bus passe par Analakely ? »','• « De Analakely à Mahamasina, quel bus prendre ? »','• « Je pars de 67Ha pour Anosy »','• « Arrêts près de moi » (après localisation sur la carte)','Je ne confirme pas les horaires, tarifs, sens de circulation ou bus en direct.'].join('\n');}
  function assistantTripAnswer(plan){if(plan.kind==='error')return `${plan.title} : ${plan.text}`;if(plan.kind==='ambiguous'){const field=plan.field==='from'?'départ':'destination';return `Je trouve plusieurs lieux pour le ${field} : ${plan.matches.slice(0,5).map((stop)=>stop.label).join(' ; ')}. Précisez le lieu avant que je propose un trajet.`;}if(plan.kind==='direct')return `Trajet ${plan.from} → ${plan.to}. Lignes présentes aux deux endroits dans les données : ${plan.direct.slice(0,8).map((item)=>item.route.name).join(', ')}. Vérifiez le terminus, le sens et la disponibilité du bus avant de monter.`;if(plan.kind==='transfer')return `Je ne confirme pas de bus direct. Correspondances visibles dans les données : ${plan.transfers.slice(0,3).map((item)=>`${item.first.name} puis ${item.second.name} à ${item.change.label}`).join(' ; ')}. Vérifiez les directions sur place.`;return `Je ne peux pas confirmer de trajet direct ou de correspondance fiable entre ${plan.from} et ${plan.to} avec les données actuelles.`;}
  function assistantAnswer(question){const q=normalise(question);if(!q)return 'Écrivez par exemple « De Analakely à Mahamasina » ou « Ligne 109 ». ';if(/\b(aide|help|exemple|exemples|prompt|prompts|tu comprends|que peux-tu)\b/.test(q))return assistantHelp();if(/\b(bonjour|salut|hello)\b/.test(q))return 'Bonjour ! Je suis l’assistant local Betax. Tapez « aide » pour voir les demandes comprises.';const trip=extractTrip(question);if(trip)return assistantTripAnswer(planTrip(trip.from,trip.to));if(/\b(pres|proche|autour de moi|a cote|à cote)\b/.test(q)){if(!state.location)return 'Activez « Me localiser » sur la carte, puis demandez les arrêts près de vous.';const near=nearbyStops();return near.length?`Arrêts géolocalisés les plus proches : ${near.slice(0,5).map(({stop,distance})=>`${stop.label} (${Math.round(distance)} m)`).join(' ; ')}.`:'Votre position est connue, mais aucun arrêt avec coordonnées n’est encore disponible près de vous.';}const routeTerm=q.match(/\b(?:ligne|bus)\s+([a-z0-9][a-z0-9 .-]*)/i);if(routeTerm){const routes=routeMatches(routeTerm[1]);if(routes.length)return `Ligne(s) trouvée(s) : ${routes.slice(0,5).map((route)=>`${route.name} (${route.stops.length} arrêts)`).join(' ; ')}. Ouvrez la page Lignes pour voir la fiche détaillée.`;}const cleaned=q.replace(/\b(quel|quelle|quels|bus|ligne|passe|passent|par|arret|arrete|stop|pour|voir|trouver|montre|moi|le|la|les|un|une|de|du|des|a|au|aux|est|sont|dans)\b/g,' ').replace(/\s+/g,' ').trim();const stops=stopMatches(cleaned||q,3);if(stops.length){const best=stops[0];if(stops.length>1&&scoreStop(stops[0],cleaned)===scoreStop(stops[1],cleaned))return ambiguousMessage(cleaned,stops);return `📍 ${best.label} est desservi par : ${best.routes.slice(0,12).join(', ')||'aucune ligne indiquée'}.`;}return 'Je ne peux répondre qu’avec les lignes, arrêts, trajets et carte Betax. Tapez « aide » pour les exemples compris.';}
  function appendChat(messages,value,role='bot'){const msg=make('div',`chat-message ${role}`,value);messages.append(msg);messages.scrollTop=messages.scrollHeight;return msg;}
  function appendTyping(messages){const msg=make('div','chat-message bot chat-typing','');msg.innerHTML='<span></span><span></span><span></span>';messages.append(msg);messages.scrollTop=messages.scrollHeight;return msg;}
  const ASSISTANT_STOPWORDS=new Set(['je','tu','il','elle','on','nous','vous','ils','elles','le','la','les','un','une','des','de','du','d','a','à','au','aux','et','ou','que','qui','quoi','quel','quelle','quels','quelles','pour','avec','sans','sur','dans','par','ce','cette','ces','mon','ma','mes','ton','ta','tes','son','sa','ses','notre','nos','votre','vos','leur','leurs','suis','es','est','sommes','etes','sont','veux','veut','voudrais','voudrait','souhaite','souhaiterais','souhaitez','dois','doit','devrais','peux','peut','pourrais','aller','allez','partir','venir','prendre','prends','rendre','actuellement','maintenant','svp','stp','merci','bonjour','salut','hello','bus','ligne','lignes','arret','arrets','arrete','stop','trajet','chemin','route','depuis','vers','jusqu','jusqua']);
  // Repère les mots susceptibles d'être des noms de lieux dans une question écrite librement
  // (peu importe l'ordre ou la formulation), pour ne pas dépendre d'une phrase parfaitement tournée.
  function extractPlaceCandidates(question){
    const words=normalise(question).replace(/[^a-z0-9' -]/g,' ').split(/\s+/).map((w)=>w.trim()).filter((w)=>w.length>2&&!ASSISTANT_STOPWORDS.has(w));
    return unique(words);
  }
  // Construit un contexte de données Betax réellement pertinent pour la question, pour que l'IA
  // réponde sans jamais inventer d'horaires, de tarifs ou de positions de bus.
  function buildAssistantContext(question){
    const parts=[];
    const trip=extractTrip(question);
    let tripStops=[];
    if(trip){const plan=planTrip(trip.from,trip.to);tripStops=[...(plan.originStops||[]),...(plan.destStops||[])];parts.push(`Trajet demandé ${trip.from} -> ${trip.to} : ${JSON.stringify({
      resultat:plan.kind,
      lignes_directes:(plan.direct||[]).slice(0,5).map((d)=>d.route.name),
      correspondances:(plan.transfers||[]).slice(0,3).map((t)=>({via:t.change.label,lignes:[t.first.name,t.second.name]})),
      lieux_depart_trouves:(plan.originStops||[]).slice(0,5).map((s)=>s.label),
      lieux_destination_trouves:(plan.destStops||[]).slice(0,5).map((s)=>s.label)
    })}`);}
    const routeTerm=normalise(question).match(/\b(?:ligne|bus)\s+([a-z0-9][a-z0-9 .-]*)/i);
    const routesFound=routeTerm?routeMatches(routeTerm[1]):routeMatches(question);
    if(routesFound.length)parts.push(`Lignes correspondantes : ${routesFound.slice(0,5).map((r)=>`${r.name} (${r.stops.length} arrêts ; ex. ${r.stops.slice(0,3).map((s)=>parseStop(s).label).join(' ; ')})`).join(' | ')}`);
    // Repli robuste : si la phrase entière ne correspond à rien, on cherche chaque mot-clé séparément
    // (ex. « je voudrais aller a analakel » -> le mot « analakel » suffit à retrouver l'arrêt).
    const wholeSentence=stopMatches(question,5);
    const perWord=extractPlaceCandidates(question).flatMap((word)=>stopMatches(word,3));
    const stopsFound=[...new Map([...wholeSentence,...perWord,...tripStops].map((s)=>[s.id,s])).values()].slice(0,8);
    if(stopsFound.length)parts.push(`Arrêts correspondant aux lieux mentionnés : ${stopsFound.map((s)=>`${s.label} (lignes : ${s.routes.slice(0,6).join(', ')||'non indiquées'})`).join(' | ')}`);
    // Si deux lieux distincts ont été repérés mais qu'aucun trajet explicite n'a été détecté,
    // on propose quand même un plan entre les deux meilleurs candidats à titre d'hypothèse.
    if(!trip){const places=unique(stopsFound.map((s)=>s.place||s.name));if(places.length>=2){const guess=planTrip(places[0],places[1]);parts.push(`Hypothèse de trajet entre les deux lieux repérés (${places[0]} et ${places[1]}, à confirmer avec l'utilisateur) : ${JSON.stringify({resultat:guess.kind,lignes_directes:(guess.direct||[]).slice(0,5).map((d)=>d.route.name),correspondances:(guess.transfers||[]).slice(0,3).map((t)=>({via:t.change.label,lignes:[t.first.name,t.second.name]}))})}`);}}
    if(state.location){const near=nearbyStops();if(near.length)parts.push(`Arrêts géolocalisés proches de l'utilisateur : ${near.slice(0,5).map(({stop,distance})=>`${stop.label} (${Math.round(distance)} m)`).join(' ; ')}`);}
    return parts.length?parts.join('\n'):'Aucune donnée Betax (lignes, arrêts, trajet) ne correspond directement à cette question.';
  }
  // Set this to the deployed HTTPS backend URL before testing from Live Server.
  const CHAT_BACKEND_URL = window.BETAX_BACKEND_URL || '';

  // The Android bridge handles requests inside the APK. The browser needs a public backend URL.
  function requestThroughAndroidBridge(payload) {
    return new Promise((resolve, reject) => {
      if (!window.BetaxAndroid || typeof window.BetaxAndroid.sendChatMessage !== 'function') {
        reject(new Error('Android bridge unavailable. Set window.BETAX_BACKEND_URL for Live Server.'));
        return;
      }
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Android backend request timed out.'));
      }, 30000);
      const previousResponse = window.handleNativeResponse;
      const previousError = window.handleNativeError;
      const cleanup = () => {
        window.clearTimeout(timer);
        window.handleNativeResponse = previousResponse;
        window.handleNativeError = previousError;
      };
      window.handleNativeResponse = (responseJson) => {
        cleanup();
        try { resolve(JSON.parse(responseJson)); } catch (_) { reject(new Error('Invalid backend JSON response.')); }
      };
      window.handleNativeError = (message) => { cleanup(); reject(new Error(message || 'Android backend request failed.')); };
      window.BetaxAndroid.sendChatMessage(JSON.stringify(payload));
    });
  }

  async function aiAssistantAnswer(question, history) {
    const messages = [
      ...history.slice(-6).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      })),
      { role: 'user', content: question }
    ];

    const payload = {
      messages,
      model: 'llama-3.3-70b-versatile',
      max_tokens: 500,
      temperature: 0.5
    };

    const data = window.BetaxAndroid
      ? await requestThroughAndroidBridge(payload)
      : await (async () => {
        if (!CHAT_BACKEND_URL) {
          throw new Error('Backend URL missing. Set window.BETAX_BACKEND_URL in index.html or deploy the backend on Render.');
        }
        const response = await fetch(`${CHAT_BACKEND_URL.replace(/\/$/, '')}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          let detail = `Backend HTTP ${response.status}`;
          try { const error = await response.json(); detail = error?.error || detail; } catch (_) { /* ignore */ }
          throw new Error(detail);
        }
        return response.json();
      })();

    if (!data) {
      throw new Error('Backend URL missing. Set window.BETAX_BACKEND_URL in index.html or use the Android APK.');
    }
    const answer = data?.reply || data?.result?.choices?.[0]?.message?.content || '';
    if (!answer) {
      throw new Error('Réponse vide du serveur Groq.');
    }
    return answer;
  }
  function initialiseAssistant(){
    const launcher=button('','chat-launcher');
    launcher.innerHTML='<span aria-hidden="true">✦</span><span class="chat-pulse" aria-hidden="true"></span>';
    launcher.setAttribute('aria-label','Ouvrir le chatbot Betax');

    const drawer=make('aside','chat-drawer');
    drawer.hidden=true;
    drawer.setAttribute('aria-label','Chatbot Betax');

    const header=make('div','chat-header');
    const h=make('div');
    h.append(make('strong','','Chatbot Betax'), make('small','','Réponses via le backend Groq'));

    const headerActions=make('div','chat-header-actions');
    const close=button('×','chat-close');
    close.setAttribute('aria-label','Fermer le chatbot');
    headerActions.append(close);
    header.append(h, headerActions);

    const scope=make('p','chat-scope','Lignes - arrêts - trajets - carte Antananarivo');
    const status=make('p','chat-ai-status');
    status.textContent='Chatbot actif • backend Groq sécurisé';
    status.classList.add('ai-on');

    const messages=make('div','chat-messages');
    messages.setAttribute('aria-live','polite');
    appendChat(messages,'Bonjour ! Je suis le chatbot Betax. Demandez-moi une ligne, un arrêt ou un trajet.');

    const suggestions=make('div','chat-suggestions');
    const form=make('form','chat-form');
    const input=make('input');
    input.type='text';
    input.placeholder='Ex. De Analakely à Mahamasina';
    input.setAttribute('aria-label','Votre question');
    const send=button('Envoyer','','');
    send.type='submit';
    form.append(input, send);

    let chatHistory=[];
    let busy=false;

    const ask=async(value)=>{
      const q=text(value).trim();
      if(!q||busy) return;
      busy=true;
      input.value='';
      appendChat(messages,q,'user');
      const typing=appendTyping(messages);

      try {
        const answer = await aiAssistantAnswer(q, chatHistory);
        typing.remove();
        appendChat(messages, answer, 'bot');
        chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
      } catch (error) {
        typing.remove();
        appendChat(messages, `⚠ ${error.message || 'Backend Groq indisponible.'}`, 'bot chat-note');
        console.error('Groq backend error:', error);
      } finally {
        busy=false;
      }
    };

    ['De Analakely à Mahamasina', 'Quel bus passe par Anosy ?', 'Ligne 109', 'Arrêts près de moi', 'Aide'].forEach((q) => suggestions.append(button(q,'',()=>ask(q))));
    form.addEventListener('submit',(e)=>{e.preventDefault(); ask(input.value);});

    drawer.append(header, scope, status, messages, suggestions, form);
    document.body.append(launcher, drawer);

    const open=()=>{drawer.hidden=false; launcher.hidden=true; window.setTimeout(()=>input.focus(),80);};
    const shut=()=>{drawer.hidden=true; launcher.hidden=false;};
    launcher.addEventListener('click', open);
    close.addEventListener('click', shut);
    $$('[data-open-chat]').forEach((el)=>el.addEventListener('click', open));
  }

  // Onboarding, feedback, PWA.
  function initialiseOnboarding(){if(document.body.dataset.page!=='home')return;let seen=false;try{seen=localStorage.getItem(ONBOARDING_KEY)==='seen';}catch(_){/* ignore */}if(seen)return;const overlay=make('div','onboarding-overlay');const card=make('section','onboarding-card');const slides=[['Bienvenue dans Betax','Trouvez une ligne, un arrêt ou commencez directement avec Départ et Destination.','⌁'],['Carte limitée à Antananarivo','Autorisez la position seulement si vous voulez repérer les arrêts géolocalisés autour de vous.','◉'],['Des résultats transparents','Betax ne fabrique ni horaires, ni position de bus, ni sens de circulation : vérifiez le terminus avant de monter.','✓']];let index=0;const paint=()=>{clear(card);const s=slides[index];card.append(make('span','onboard-icon',s[2]),make('p','eyebrow',`Étape ${index+1} / ${slides.length}`),make('h2','',s[0]),make('p','',s[1]));const actions=make('div','onboard-actions');const skip=button('Passer','button button-ghost',finish);const next=button(index===slides.length-1?'Commencer':'Suivant','button button-primary',()=>{if(index<slides.length-1){index++;paint();}else finish();});actions.append(skip,next);card.append(actions);};const finish=()=>{try{localStorage.setItem(ONBOARDING_KEY,'seen');}catch(_){/* ignore */}overlay.remove();};overlay.append(card);document.body.append(overlay);paint();}
  function initialiseFeedback(){const form=$('#feedbackForm'),type=$('#feedbackType'),message=$('#feedbackText'),result=$('#feedbackResult');if(!form)return;form.addEventListener('submit',(e)=>{e.preventDefault();const body=message.value.trim();if(!body){result.textContent='Écrivez votre message avant de préparer le signalement.';return;}const subject=`[Betax] ${type.value}`;const mail=`mailto:contact@betax.mg?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${body}\n\nEnvoyé depuis Final Projet Betax.`)}`;clear(result);result.append(make('span','', 'Votre signalement est prêt. '),link('Ouvrir l’e-mail',mail,'text-link'));});}
  function initialisePWA(){if('serviceWorker'in navigator&&['https:','http:'].includes(location.protocol)){navigator.serviceWorker.register('sw.js').catch(()=>{});}const toast=make('div','network-toast');toast.hidden=true;document.body.append(toast);const update=()=>{toast.hidden=navigator.onLine;if(!navigator.onLine){toast.textContent='Mode hors ligne : les données déjà enregistrées restent disponibles.';}};window.addEventListener('online',update);window.addEventListener('offline',update);update();}

  document.addEventListener('DOMContentLoaded', async () => {
    initialiseTheme(); initialiseAssistant(); initialisePWA(); initialiseOnboarding(); initialiseQuickJourney(); initialiseFeedback();
    try { await loadData(); const page=document.body.dataset.page; if(page==='bus')initialiseBusPage(); if(page==='stop')initialiseStopPage(); if(page==='route-detail')initialiseRouteDetail(); if(page==='journey')initialiseJourney(); if(page==='map')initialiseMap(); renderSavedSections(); }
    catch(error){ console.error(error); showDataFailure(error); }
  });
})();
